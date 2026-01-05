require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Storage for rooms
const rooms = new Map();

// File upload setup
const upload = multer({ dest: 'uploads/' });

// Google AI setup
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

app.use(express.static('public'));
app.use(express.json());

// Create a room
app.post('/api/create-room', (req, res) => {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms.set(roomCode, {
    players: [],
    questions: [],
    currentQuestion: 0,
    scores: {},
    playerAnswers: {}, // Track each player's answers
    status: 'waiting',
    courseContent: ''
  });
  res.json({ roomCode });
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
    const filePath = req.file.path;
    if (req.file.originalname.endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      content = data.text;
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
    fs.unlinkSync(filePath);
  } else if (req.body.content) {
    content = req.body.content;
  }

  room.courseContent = content;
  
  try {
    const numQuestions = req.body.numQuestions || 10;
    
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

    console.log('Generating quiz with gemini-2.0-flash-lite...');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text();
    
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('Generated quiz successfully!');
    
    const quizData = JSON.parse(text);
    room.questions = quizData.questions;
    
    io.to(roomCode).emit('quiz-ready', { numQuestions: room.questions.length });
    res.json({ success: true, numQuestions: room.questions.length });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz: ' + error.message });
  }
});

// Socket.io for real-time
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = playerName;

    if (!room.players.find(p => p.name === playerName)) {
      room.players.push({ id: socket.id, name: playerName });
      room.scores[playerName] = 0;
      room.playerAnswers[playerName] = []; // Initialize answer tracking
    }

    io.to(roomCode).emit('player-joined', {
      players: room.players,
      scores: room.scores
    });

    socket.emit('room-state', {
      status: room.status,
      players: room.players,
      scores: room.scores,
      hasQuiz: room.questions.length > 0
    });
  });

  socket.on('start-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.questions.length === 0) return;

    room.status = 'playing';
    room.currentQuestion = 0;
    
    for (let player of room.players) {
      room.scores[player.name] = 0;
      room.playerAnswers[player.name] = [];
    }

    sendQuestion(roomCode);
  });

  socket.on('submit-answer', ({ roomCode, answerIndex, timeLeft }) => {
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'playing') return;

    const question = room.questions[room.currentQuestion];
    const isCorrect = answerIndex === question.correct;
    
    // Track this answer
    if (room.playerAnswers[socket.playerName]) {
      room.playerAnswers[socket.playerName].push({
        questionIndex: room.currentQuestion,
        question: question.question,
        playerAnswer: answerIndex,
        correctAnswer: question.correct,
        options: question.options,
        explanation: question.explanation,
        isCorrect: isCorrect
      });
    }
    
    if (isCorrect) {
      const points = Math.max(100, Math.floor(timeLeft * 100));
      room.scores[socket.playerName] = (room.scores[socket.playerName] || 0) + points;
    }

    socket.emit('answer-result', {
      correct: isCorrect,
      correctAnswer: question.correct,
      explanation: question.explanation,
      points: isCorrect ? Math.max(100, Math.floor(timeLeft * 100)) : 0
    });
  });

  socket.on('next-question', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.currentQuestion++;
    
    if (room.currentQuestion >= room.questions.length) {
      room.status = 'finished';
      
      // Send game over with detailed results for each player
      room.players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.emit('game-over', {
            scores: room.scores,
            winner: Object.entries(room.scores).sort((a, b) => b[1] - a[1])[0],
            myAnswers: room.playerAnswers[player.name] || [],
            questions: room.questions
          });
        }
      });
    } else {
      sendQuestion(roomCode);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(socket.roomCode).emit('player-left', {
          players: room.players,
          playerName: socket.playerName
        });
      }
    }
  });
});

function sendQuestion(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const question = room.questions[room.currentQuestion];
  io.to(roomCode).emit('question', {
    questionNum: room.currentQuestion + 1,
    totalQuestions: room.questions.length,
    question: question.question,
    options: question.options,
    timeLimit: 15
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🚀 Quiz server running on http://localhost:' + PORT);
});

module.exports = app;
