const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the game files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

// ─────────────────────────────────────────
//  GAME CONSTANTS
// ─────────────────────────────────────────
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [2,3,4,5,6,7,8,9,10,'J','Q','K','A'];
const RANK_VALUE = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:1};
const CHIPS_START = 3;
const BOT_DELAY_MS = 1000;

// ─────────────────────────────────────────
//  ROOMS
//  rooms = Map<roomCode, room>
//  room = { players, gameState, options }
//  player = { id, name, chips, card, eliminated, seatIndex, isBot }
// ─────────────────────────────────────────
const rooms = new Map();

function makeRoom(code, options = {}) {
  return { code, players: [], gameState: null, options };
}

function getRoom(code) {
  return rooms.get(code);
}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardValue(card) {
  return RANK_VALUE[card?.rank] ?? 99;
}

function alivePlayers(room) {
  return room.players.filter(p => !p.eliminated && p.chips > 0);
}

function nextAliveIndex(room, from, step = 1) {
  const n = room.players.length;
  let idx = from;
  for (let i = 0; i < n * 2; i++) {
    idx = ((idx + step) % n + n) % n;
    const p = room.players[idx];
    if (p && !p.eliminated && p.chips > 0) return idx;
  }
  return -1;
}

function isBot(player) {
  return !!player?.isBot;
}

// ─────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────
function startGame(room) {
  const gs = {
    deck: [],
    dealerIndex: 0,
    currentIndex: 0,
    turnsTaken: 0,
    phase: 'playing',
    botTimer: null
  };
  room.gameState = gs;

  // reset chips
  room.players.forEach(p => { p.chips = CHIPS_START; p.eliminated = false; p.card = null; });

  startRound(room);
}

function startRound(room) {
  const gs = room.gameState;
  if (!gs) return;

  clearBotTimer(room);
  gs.deck = makeDeck();
  gs.turnsTaken = 0;
  gs.phase = 'playing';

  // deal one card to each alive player
  alivePlayers(room).forEach(p => { p.card = gs.deck.pop(); });

  // first to act is left of dealer
  gs.currentIndex = nextAliveIndex(room, gs.dealerIndex, 1);

  broadcastState(room);
  scheduleIfBot(room);
}

function endRound(room) {
  const gs = room.gameState;
  clearBotTimer(room);
  gs.phase = 'roundEnd';

  const alive = alivePlayers(room);
  const minVal = Math.min(...alive.map(p => cardValue(p.card)));
  const losers = alive.filter(p => cardValue(p.card) === minVal);

  losers.forEach(p => {
    p.chips--;
    if (p.chips <= 0) p.eliminated = true;
  });

  // broadcast with all cards revealed
  io.to(room.code).emit('roundEnded', {
    players: room.players,
    losers: losers.map(p => ({ name: p.name, card: p.card }))
  });

  const stillAlive = alivePlayers(room);
  if (stillAlive.length <= 1) {
    const winner = stillAlive[0] || room.players[0];
    io.to(room.code).emit('gameOver', { winner: { name: winner.name } });
    room.gameState = null;
    return;
  }

  // next round after delay
  setTimeout(() => {
    if (!room.gameState) return;
    gs.dealerIndex = nextAliveIndex(room, gs.dealerIndex, 1);
    room.players.forEach(p => p.card = null);
    startRound(room);
  }, 5000);
}

function advanceTurn(room) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;

  gs.turnsTaken++;
  const alive = alivePlayers(room);

  if (gs.turnsTaken >= alive.length) {
    endRound(room);
    return;
  }

  gs.currentIndex = nextAliveIndex(room, gs.currentIndex, 1);

  // auto-skip players holding a King
  const cur = room.players[gs.currentIndex];
  if (cur?.card?.rank === 'K') {
    gs.turnsTaken++;
    if (gs.turnsTaken >= alivePlayers(room).length) {
      endRound(room);
      return;
    }
    gs.currentIndex = nextAliveIndex(room, gs.currentIndex, 1);
  }

  broadcastState(room);
  scheduleIfBot(room);
}

function handleKeep(room) {
  advanceTurn(room);
}

function handlePass(room, fromSocketId) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;

  const fromIdx = gs.currentIndex;
  const toIdx = nextAliveIndex(room, fromIdx, 1);
  const fromP = room.players[fromIdx];
  const toP = room.players[toIdx];

  if (!fromP || !toP) return;

  // King blocks
  if (fromP.card?.rank === 'K') return handleKeep(room);
  if (toP.card?.rank === 'K') {
    // blocked — notify and force keep
    io.to(room.code).emit('kingBlocked', { blockerName: toP.name });
    setTimeout(() => handleKeep(room), 1200);
    return;
  }

  // swap cards
  [fromP.card, toP.card] = [toP.card, fromP.card];

  io.to(room.code).emit('cardPassed', {
    fromIndex: fromIdx,
    toIndex: toIdx
  });

  advanceTurn(room);
}

// ─────────────────────────────────────────
//  BOT AI
// ─────────────────────────────────────────
function scheduleIfBot(room) {
  const gs = room.gameState;
  if (!gs) return;
  const cur = room.players[gs.currentIndex];
  if (!isBot(cur)) return;

  gs.botTimer = setTimeout(() => {
    if (!room.gameState) return;
    botAct(room);
  }, BOT_DELAY_MS);
}

function clearBotTimer(room) {
  if (room.gameState?.botTimer) {
    clearTimeout(room.gameState.botTimer);
    room.gameState.botTimer = null;
  }
}

function botAct(room) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;

  const cur = room.players[gs.currentIndex];
  if (!isBot(cur)) return;

  const val = cardValue(cur.card);
  const toIdx = nextAliveIndex(room, gs.currentIndex, 1);
  const toP = room.players[toIdx];
  const blocked = toP?.card?.rank === 'K' || cur.card?.rank === 'K';

  // pass if low card, keep if high
  const wantPass = !blocked && (val <= 4 || (val <= 8 && Math.random() < 0.55));

  if (wantPass) handlePass(room, null);
  else handleKeep(room);
}

// ─────────────────────────────────────────
//  STATE BROADCAST
//  Each player only sees their own card
// ─────────────────────────────────────────
function broadcastState(room) {
  const gs = room.gameState;
  if (!gs) return;

  room.players.forEach(player => {
    // build a player list where only this player's card is visible
    const sanitized = room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      eliminated: p.eliminated,
      seatIndex: p.seatIndex,
      isBot: p.isBot,
      // show card only to its owner, or if it's a King (visible to all)
      card: (p.id === player.id || p.card?.rank === 'K') ? p.card : (p.card ? 'hidden' : null)
    }));

    io.to(player.id).emit('gameState', {
      players: sanitized,
      currentIndex: gs.currentIndex,
      currentPlayerId: room.players[gs.currentIndex]?.id,
      phase: gs.phase
    });
  });
}

function getLobbyRooms() {
  return Array.from(rooms.values())
    .filter(r => r.players.length > 0)
    .map(r => ({
      code: r.code,
      playerCount: r.players.length,
      maxPlayers: r.options.seats || 8,
      inProgress: !!r.gameState,
      mode: r.options.mode || 'Classic'
    }));
}

// ─────────────────────────────────────────
//  SOCKET EVENTS
// ─────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  // send current lobby
  socket.emit('lobbyUpdate', getLobbyRooms());

  // ── Create room
  socket.on('createRoom', ({ name, seats, mode }) => {
    const code = Math.random().toString(36).slice(2,8).toUpperCase();
    const room = makeRoom(code, { seats: seats || 6, mode: mode || 'Classic' });
    rooms.set(code, room);

    const player = {
      id: socket.id, name, chips: CHIPS_START,
      eliminated: false, card: null, seatIndex: 0, isBot: false
    };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('roomCreated', { code, players: room.players });
    io.emit('lobbyUpdate', getLobbyRooms());
  });

  // ── Join room
  socket.on('joinRoom', ({ name, code }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('error', 'Room not found.'); return; }
    if (room.gameState) { socket.emit('error', 'Game already in progress.'); return; }
    if (room.players.length >= (room.options.seats || 8)) { socket.emit('error', 'Room is full.'); return; }

    const player = {
      id: socket.id, name, chips: CHIPS_START,
      eliminated: false, card: null,
      seatIndex: room.players.length, isBot: false
    };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('joinedRoom', { code, players: room.players });
    io.to(code).emit('playerList', room.players);
    io.emit('lobbyUpdate', getLobbyRooms());
  });

  // ── Start game (host only)
  socket.on('startGame', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;

    // fill remaining seats with bots
    const botNames = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery'];
    let botCount = 0;
    while (room.players.length < (room.options.seats || 6)) {
      room.players.push({
        id: `bot_${Date.now()}_${botCount}`,
        name: botNames[botCount % botNames.length],
        chips: CHIPS_START, eliminated: false, card: null,
        seatIndex: room.players.length, isBot: true
      });
      botCount++;
    }

    startGame(room);
    io.emit('lobbyUpdate', getLobbyRooms());
  });

  // ── Player actions
  socket.on('keep', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs = room.gameState;
    const cur = room.players[gs.currentIndex];
    if (cur?.id !== socket.id) return; // not your turn
    clearBotTimer(room);
    handleKeep(room);
  });

  socket.on('pass', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room?.gameState) return;
    const gs = room.gameState;
    const cur = room.players[gs.currentIndex];
    if (cur?.id !== socket.id) return; // not your turn
    clearBotTimer(room);
    handlePass(room, socket.id);
  });

  // ── Disconnect
  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);
    const code = socket.data.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit('playerList', room.players);
    }
    io.emit('lobbyUpdate', getLobbyRooms());
  });
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
