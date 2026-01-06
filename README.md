# ☁️ Cloud Quiz Battle

A real-time multiplayer quiz game for cloud computing exam revision. Upload your course content and AI generates quiz questions for you and your friends to compete!

## Features

- 🎮 **Create/Join Rooms** - Host creates a room, friends join with a code
- 📄 **Upload Course Content** - PDF, TXT, or paste your notes
- 🤖 **AI Quiz Generation** - Google Gemini generates questions from your content
- ⏱️ **Timed Questions** - 20 seconds per question, faster = more points
- 📊 **Live Scoreboard** - See who's winning in real-time
- 📝 **Review Mistakes** - At the end, see what you got wrong with explanations

## Quick Start

### Local Development

1. Clone the repo:
```bash
git clone https://github.com/Cosinusjustafonction/cloud-quiz-battle.git
cd cloud-quiz-battle
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```
GOOGLE_AI_API_KEY=your_google_ai_api_key
PORT=3000
```

4. Run:
```bash
npm start
```

5. Open http://localhost:3000

### Deploy to Vercel

1. Push to GitHub
2. Import project in Vercel
3. Add environment variable: `GOOGLE_AI_API_KEY`
4. Deploy!

## How to Play

1. **Host** clicks "Create Room" and enters their name
2. **Host** gets a 6-letter room code to share with friends
3. **Friends** click "Join Room" and enter the code + their name
4. **Host** uploads course content (PDF/TXT) or pastes notes
5. **Host** clicks "Generate Quiz" - AI creates questions
6. **Host** starts the game when everyone is ready
7. Answer questions as fast as you can!
8. Review your mistakes at the end

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JS, CSS
- **AI**: Google Gemini API (gemini-2.0-flash-lite)
- **Deployment**: Vercel-ready

## License

MIT
