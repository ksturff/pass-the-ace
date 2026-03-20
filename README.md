# Pass the Ace

## Running locally

1. Open a terminal in this folder
2. Install dependencies (first time only):
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Open your browser to: http://localhost:3000

## Testing multiplayer

Open two browser tabs at http://localhost:3000

- Tab 1: enter a name → Multiplayer → Create Room
- Tab 2: enter a name → Multiplayer → enter the room code → Join Room
- Back in Tab 1: click Start Game

## Deploying to Render (free hosting)

1. Push this folder to a GitHub repo
2. Go to render.com → New → Web Service
3. Connect your repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Deploy — you'll get a public URL anyone can use
