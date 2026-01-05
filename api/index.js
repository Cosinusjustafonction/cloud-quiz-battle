const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');

const app = express();

// In-memory storage for rooms (Note: This resets on cold starts)
global.rooms = global.rooms || new Map();
const rooms = global.rooms;

// Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Google AI setup
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

app.use(express.json());

// Create a room
app.post('/api/create-room', (req, res) => {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms.set(roomCode, {
    players: [],
    questions: [],
    currentQuestion: 0,
    scores: {},
    playerAnswers: {},
    status: 'waiting',
    courseContent: '',
    lastUpdate: Date.now()
  });
  res.json({ roomCode });
});

// Get room state (for polling)
app.get('/api/room/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    players: room.players,
    scores: room.scores,
    status: room.status,
    hasQuiz: room.questions.length > 0,
    currentQuestion: room.currentQuestion,
    totalQuestions: room.questions.length,
    lastUpdate: room.lastUpdate
  });
});

// Join room
app.post('/api/join-room/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const { playerName } = req.body;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!room.players.find(p => p.name === playerName)) {
    room.players.push({ name: playerName, joinedAt: Date.now() });
    room.scores[playerName] = 0;
    room.playerAnswers[playerName] = [];
  }
  room.lastUpdate = Date.now();

  res.json({ 
    success: true, 
    players: room.players,
    scores: room.scores
  });
});

// Upload course content and generate quiz
app.post('/api/upload-content/:roomCode', upload.single('file'), async (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  let content = '';
  
  if (req.file) {
    if (req.file.originalname.endsWith('.pdf')) {
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(req.file.buffer);
        content = data.text;
      } catch (e) {
        content = req.file.buffer.toString('utf-8');
      }
    } else {
      content = req.file.buffer.toString('utf-8');
    }
  }
  
  if (req.body.content) {
    content = content + '\n' + req.body.content;
  }

  room.courseContent = content;
  
  try {
    const numQuestions = parseInt(req.body.numQuestions) || 10;
    
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
    
    const prompt = `You are a quiz generator. Generate exactly ${numQuestions} multiple choice questions based on the provided course content.

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
${content.substring(0, 10000)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();
    
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const quizData = JSON.parse(text);
    room.questions = quizData.questions;
    room.lastUpdate = Date.now();
    
    res.json({ success: true, numQuestions: room.questions.length });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz: ' + error.message });
  }
});

// Start game
app.post('/api/start-game/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room || room.questions.length === 0) {
    return res.status(400).json({ error: 'Cannot start game' });
  }

  room.status = 'playing';
  room.currentQuestion = 0;
  room.questionStartTime = Date.now();
  
  for (let player of room.players) {
    room.scores[player.name] = 0;
    room.playerAnswers[player.name] = [];
  }
  room.lastUpdate = Date.now();

  res.json({ success: true });
});

// Get current question
app.get('/api/question/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  if (room.status === 'finished') {
    return res.json({ status: 'finished' });
  }
  
  if (room.status !== 'playing') {
    return res.json({ status: room.status });
  }

  const question = room.questions[room.currentQuestion];
  const timeElapsed = Math.floor((Date.now() - room.questionStartTime) / 1000);
  const timeLeft = Math.max(0, 20 - timeElapsed);

  res.json({
    questionNum: room.currentQuestion + 1,
    totalQuestions: room.questions.length,
    question: question.question,
    options: question.options,
    timeLeft: timeLeft,
    status: room.status,
    scores: room.scores
  });
});

// Submit answer
app.post('/api/submit-answer/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const { playerName, answerIndex } = req.body;
  const room = rooms.get(roomCode);
  
  if (!room || room.status !== 'playing') {
    return res.status(400).json({ error: 'Game not in progress' });
  }

  const question = room.questions[room.currentQuestion];
  const timeElapsed = Math.floor((Date.now() - room.questionStartTime) / 1000);
  const timeLeft = Math.max(0, 20 - timeElapsed);
  const isCorrect = answerIndex === question.correct;
  
  // Track this answer
  if (room.playerAnswers[playerName]) {
    const alreadyAnswered = room.playerAnswers[playerName].some(
      a => a.questionIndex === room.currentQuestion
    );
    
    if (!alreadyAnswered) {
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
        const points = Math.max(100, Math.floor(timeLeft * 100));
        room.scores[playerName] = (room.scores[playerName] || 0) + points;
      }
    }
  }
  room.lastUpdate = Date.now();

  res.json({
    correct: isCorrect,
    correctAnswer: question.correct,
    explanation: question.explanation,
    points: isCorrect ? Math.max(100, Math.floor(timeLeft * 100)) : 0,
    scores: room.scores
  });
});

// Next question (host only)
app.post('/api/next-question/:roomCode', (req, res) => {
  const { roomCode } = req.params;
  const room = rooms.get(roomCode);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  room.currentQuestion++;
  room.questionStartTime = Date.now();
  room.lastUpdate = Date.now();
  
  if (room.currentQuestion >= room.questions.length) {
    room.status = 'finished';
  }

  res.json({ success: true, status: room.status });
});

// Get results
app.get('/api/results/:roomCode/:playerName', (req, res) => {
  const { roomCode, playerName } = req.params;
  const room = rooms.get(roomCode);
  
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

module.exports = app;
