const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const Redis = require('ioredis');

const app = express();

// Support multiple file uploads (up to 10 files)
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
const redis = new Redis(process.env.REDIS_URL);

app.use(express.json());

// TIMER SETTINGS
const QUESTION_TIME = 30;
const REVEAL_TIME = 5;

async function getRoom(roomCode) {
  try {
    const data = await redis.get(`room:${roomCode}`);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error('Redis get error:', e);
    return null;
  }
}

async function setRoom(roomCode, room) {
  try {
    await redis.setex(`room:${roomCode}`, 7200, JSON.stringify(room));
    return true;
  } catch (e) {
    console.error('Redis set error:', e);
    return false;
  }
}

// Get/set saved quizzes (persist for 30 days)
async function getSavedQuiz(quizId) {
  try {
    const data = await redis.get(`quiz:${quizId}`);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

async function saveQuiz(quizId, quizData) {
  try {
    await redis.setex(`quiz:${quizId}`, 2592000, JSON.stringify(quizData)); // 30 days
    return true;
  } catch (e) {
    return false;
  }
}

// Get list of saved quizzes
async function listSavedQuizzes() {
  try {
    const keys = await redis.keys('quiz:*');
    const quizzes = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const quiz = JSON.parse(data);
        quizzes.push({
          id: key.replace('quiz:', ''),
          name: quiz.name,
          questionCount: quiz.questions.length,
          createdAt: quiz.createdAt
        });
      }
    }
    return quizzes.sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    return [];
  }
}

// Get public rooms
async function getPublicRooms() {
  try {
    const keys = await redis.keys('room:*');
    const rooms = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const room = JSON.parse(data);
        if (room.isPublic && room.status === 'waiting') {
          rooms.push({
            code: key.replace('room:', ''),
            name: room.name,
            playerCount: room.players.length,
            hasQuiz: room.questions.length > 0,
            createdAt: room.createdAt
          });
        }
      }
    }
    return rooms.sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    return [];
  }
}

// Create a room
app.post('/api/create-room', async (req, res) => {
  const { roomName, isPublic } = req.body;
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  const room = {
    name: roomName || 'Quiz Room',
    isPublic: isPublic !== false,
    players: [],
    questions: [],
    currentQuestion: 0,
    scores: {},
    playerAnswers: {},
    status: 'waiting',
    phase: 'waiting',
    courseContent: '',
    createdAt: Date.now(),
    lastUpdate: Date.now()
  };
  
  await setRoom(roomCode, room);
  res.json({ roomCode });
});

// Get public rooms
app.get('/api/public-rooms', async (req, res) => {
  const rooms = await getPublicRooms();
  res.json({ rooms });
});

// Get saved quizzes
app.get('/api/saved-quizzes', async (req, res) => {
  const quizzes = await listSavedQuizzes();
  res.json({ quizzes });
});

// Get room state
app.get('/api/room/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  const room = await getRoom(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    name: room.name,
    isPublic: room.isPublic,
    players: room.players,
    scores: room.scores,
    status: room.status,
    phase: room.phase,
    hasQuiz: room.questions.length > 0,
    questionCount: room.questions.length,
    currentQuestion: room.currentQuestion,
    totalQuestions: room.questions.length,
    lastUpdate: room.lastUpdate
  });
});

// Join room
app.post('/api/join-room/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  const { playerName } = req.body;
  const room = await getRoom(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!room.players.find(p => p.name === playerName)) {
    room.players.push({ name: playerName, joinedAt: Date.now() });
  }
  
  if (room.scores[playerName] === undefined) {
    room.scores[playerName] = 0;
  }
  
  if (!room.playerAnswers[playerName]) {
    room.playerAnswers[playerName] = [];
  }
  
  room.lastUpdate = Date.now();
  await setRoom(roomCode, room);

  res.json({ 
    success: true, 
    players: room.players,
    scores: room.scores,
    status: room.status
  });
});

// Upload multiple files and generate quiz
app.post('/api/upload-content/:roomCode', upload.array('files', 10), async (req, res) => {
  const { roomCode } = req.params;
  const room = await getRoom(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  let allContent = '';
  const fileNames = [];
  
  // Process multiple files
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      fileNames.push(file.originalname);
      let fileContent = '';
      
      if (file.originalname.endsWith('.pdf')) {
        try {
          const pdfParse = require('pdf-parse');
          const data = await pdfParse(file.buffer);
          fileContent = data.text;
        } catch (e) {
          fileContent = file.buffer.toString('utf-8');
        }
      } else {
        fileContent = file.buffer.toString('utf-8');
      }
      
      allContent += `\n\n=== ${file.originalname} ===\n${fileContent}`;
    }
  }
  
  // Add pasted content
  if (req.body.content) {
    allContent += '\n\n=== Pasted Content ===\n' + req.body.content;
  }

  room.courseContent = allContent;
  room.fileNames = fileNames;
  
  const quizName = req.body.quizName || fileNames.join(', ') || 'Untitled Quiz';
  const numQuestions = parseInt(req.body.numQuestions) || 10;
  const useExisting = req.body.useExisting; // Quiz ID to use existing questions
  const mixMode = req.body.mixMode === 'true'; // Mix existing + new questions
  const mixCount = parseInt(req.body.mixCount) || 5; // How many new questions in mix mode
  
  try {
    let questions = [];
    
    // Load existing quiz if specified
    if (useExisting) {
      const existingQuiz = await getSavedQuiz(useExisting);
      if (existingQuiz) {
        if (mixMode) {
          // Use some existing questions
          const shuffled = existingQuiz.questions.sort(() => Math.random() - 0.5);
          questions = shuffled.slice(0, numQuestions - mixCount);
        } else {
          // Use all existing questions
          questions = existingQuiz.questions;
        }
      }
    }
    
    // Generate new questions if needed
    const needNewQuestions = !useExisting || mixMode;
    const newQuestionsCount = mixMode ? mixCount : numQuestions;
    
    if (needNewQuestions && allContent.trim()) {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
      
      const prompt = `You are a quiz generator. Generate exactly ${newQuestionsCount} multiple choice questions based on the provided course content.

Return ONLY valid JSON in this exact format (no markdown, no code blocks, no backticks):
{
  "questions": [
    {
      "question": "Question text here?",
      "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
      "correct": 0,
      "explanation": "Brief explanation"
    }
  ]
}

The "correct" field should be the index (0-3) of the correct option.
Make questions challenging but fair. Cover different topics from the content.

Course content:
${allContent.substring(0, 15000)}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();
      text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const quizData = JSON.parse(text);
      questions = [...questions, ...quizData.questions];
    }
    
    // Shuffle all questions
    questions = questions.sort(() => Math.random() - 0.5);
    
    room.questions = questions;
    room.lastUpdate = Date.now();
    
    await setRoom(roomCode, room);
    
    // Save the quiz for future use
    const quizId = Math.random().toString(36).substring(2, 10);
    await saveQuiz(quizId, {
      name: quizName,
      questions: questions,
      fileNames: fileNames,
      createdAt: Date.now()
    });
    
    res.json({ 
      success: true, 
      numQuestions: questions.length,
      quizId: quizId,
      quizName: quizName
    });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz: ' + error.message });
  }
});

// Load saved quiz into room
app.post('/api/load-quiz/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  const { quizId } = req.body;
  
  const room = await getRoom(roomCode);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const quiz = await getSavedQuiz(quizId);
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  
  // Shuffle questions
  room.questions = quiz.questions.sort(() => Math.random() - 0.5);
  room.lastUpdate = Date.now();
  
  await setRoom(roomCode, room);
  
  res.json({
    success: true,
    numQuestions: room.questions.length,
    quizName: quiz.name
  });
});

// Start game
app.post('/api/start-game/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  const room = await getRoom(roomCode);
  
  if (!room || room.questions.length === 0) {
    return res.status(400).json({ error: 'Cannot start game' });
  }

  room.status = 'playing';
  room.phase = 'answering';
  room.currentQuestion = 0;
  room.questionStartTime = Date.now();
  room.currentQuestionAnswers = {};
  
  for (let player of room.players) {
    room.scores[player.name] = 0;
    room.playerAnswers[player.name] = [];
  }
  room.lastUpdate = Date.now();
  
  await setRoom(roomCode, room);
  res.json({ success: true });
});

// Get current question - handles automatic phase transitions
app.get('/api/question/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  let room = await getRoom(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  if (room.status === 'finished') {
    return res.json({ status: 'finished', scores: room.scores });
  }
  
  if (room.status !== 'playing') {
    return res.json({ status: room.status });
  }

  const now = Date.now();
  const timeElapsed = Math.floor((now - room.questionStartTime) / 1000);
  
  // Handle phase transitions
  if (room.phase === 'answering' && timeElapsed >= QUESTION_TIME) {
    room.phase = 'revealing';
    room.revealStartTime = now;
    await setRoom(roomCode, room);
  }
  
  if (room.phase === 'revealing') {
    const revealElapsed = Math.floor((now - room.revealStartTime) / 1000);
    if (revealElapsed >= REVEAL_TIME) {
      room.currentQuestion++;
      room.currentQuestionAnswers = {};
      
      if (room.currentQuestion >= room.questions.length) {
        room.status = 'finished';
        await setRoom(roomCode, room);
        return res.json({ status: 'finished', scores: room.scores });
      }
      
      room.phase = 'answering';
      room.questionStartTime = now;
      await setRoom(roomCode, room);
    }
  }

  const question = room.questions[room.currentQuestion];
  
  if (room.phase === 'answering') {
    const timeLeft = Math.max(0, QUESTION_TIME - Math.floor((now - room.questionStartTime) / 1000));
    
    res.json({
      questionNum: room.currentQuestion + 1,
      totalQuestions: room.questions.length,
      question: question.question,
      options: question.options,
      timeLeft: timeLeft,
      timeLimit: QUESTION_TIME,
      phase: 'answering',
      status: room.status,
      scores: room.scores
    });
  } else {
    const revealTimeLeft = Math.max(0, REVEAL_TIME - Math.floor((now - room.revealStartTime) / 1000));
    
    res.json({
      questionNum: room.currentQuestion + 1,
      totalQuestions: room.questions.length,
      question: question.question,
      options: question.options,
      correctAnswer: question.correct,
      explanation: question.explanation,
      timeLeft: revealTimeLeft,
      phase: 'revealing',
      status: room.status,
      scores: room.scores
    });
  }
});

// Submit answer
app.post('/api/submit-answer/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  const { playerName, answerIndex } = req.body;
  const room = await getRoom(roomCode);
  
  if (!room || room.status !== 'playing' || room.phase !== 'answering') {
    return res.status(400).json({ error: 'Cannot submit answer now' });
  }

  if (!room.players.find(p => p.name === playerName)) {
    room.players.push({ name: playerName, joinedAt: Date.now() });
  }
  if (room.scores[playerName] === undefined) {
    room.scores[playerName] = 0;
  }
  if (!room.playerAnswers[playerName]) {
    room.playerAnswers[playerName] = [];
  }
  if (!room.currentQuestionAnswers) {
    room.currentQuestionAnswers = {};
  }

  if (room.currentQuestionAnswers[playerName]) {
    return res.json({ alreadyAnswered: true });
  }

  const question = room.questions[room.currentQuestion];
  const timeElapsed = Math.floor((Date.now() - room.questionStartTime) / 1000);
  const timeLeft = Math.max(0, QUESTION_TIME - timeElapsed);
  const isCorrect = answerIndex === question.correct;
  
  room.currentQuestionAnswers[playerName] = answerIndex;
  
  room.playerAnswers[playerName].push({
    questionIndex: room.currentQuestion,
    question: question.question,
    playerAnswer: answerIndex,
    correctAnswer: question.correct,
    options: question.options,
    explanation: question.explanation,
    isCorrect: isCorrect
  });
  
  if (isCorrect) {
    const points = Math.max(100, Math.floor(timeLeft * 50));
    room.scores[playerName] = (room.scores[playerName] || 0) + points;
  }
  
  room.lastUpdate = Date.now();
  await setRoom(roomCode, room);

  res.json({
    submitted: true,
    myAnswer: answerIndex,
    scores: room.scores
  });
});

// Get results
app.get('/api/results/:roomCode/:playerName', async (req, res) => {
  const { roomCode, playerName } = req.params;
  const room = await getRoom(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const sortedScores = Object.entries(room.scores).sort((a, b) => b[1] - a[1]);
  
  res.json({
    scores: room.scores,
    winner: sortedScores[0] || ['No winner', 0],
    myAnswers: room.playerAnswers[playerName] || [],
    status: room.status
  });
});

// Delete a saved quiz
app.delete('/api/quiz/:quizId', async (req, res) => {
  const { quizId } = req.params;
  try {
    await redis.del(`quiz:${quizId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

module.exports = app;
