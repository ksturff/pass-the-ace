const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

// ─────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [2,3,4,5,6,7,8,9,10,'J','Q','K','A'];
const RANK_VALUE = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:1};
const CHIPS_START = 3;
const BOT_DELAY_MS = 1200;
const MAX_PLAYERS = 10;
const TOURNAMENT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const REGISTRATION_OPEN_MS = 14 * 60 * 1000;   // open 14 min before start
const BOT_NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery','Blake'];
const BOT_AVATARS = ['🐺','🦁','🐯','🦅','🐉','🦈','👾','🤖','💀','🦂'];

// ─────────────────────────────────────────
//  ROOMS (private multiplayer)
// ─────────────────────────────────────────
const rooms = new Map();

function makeRoom(code, options = {}) {
  return { code, players: [], gameState: null, options, type: 'room' };
}
function getRoom(code) { return rooms.get(code); }

// ─────────────────────────────────────────
//  TOURNAMENTS
// ─────────────────────────────────────────
const tournaments = new Map(); // id -> tournament

function getNextTournamentTimes(count = 200) {
  const now = Date.now();
  const interval = TOURNAMENT_INTERVAL_MS;
  const times = [];
  // Start from beginning of current day
  const startOfDay = new Date();
  startOfDay.setHours(0,0,0,0);
  const dayStart = startOfDay.getTime();
  // Find first 15-min slot of the day
  const firstSlot = Math.ceil(dayStart / interval) * interval;
  for (let i = 0; i < count; i++) {
    times.push(firstSlot + i * interval);
  }
  return times;
}

function getTournamentId(startTime) {
  return `tournament_${startTime}`;
}

function ensureTournamentsExist() {
  const times = getNextTournamentTimes(8);
  times.forEach(startTime => {
    const id = getTournamentId(startTime);
    if (!tournaments.has(id)) {
      tournaments.set(id, {
        id,
        startTime,
        players: [],    // registered human players
        gameState: null,
        status: 'registering', // registering | starting | inProgress | finished
        winners: []
      });
    }
  });
  // Clean up tournaments older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, t] of tournaments.entries()) {
    if (t.startTime < cutoff) {
      tournaments.delete(id);
    }
  }
}

function getPublicTournaments() {
  ensureTournamentsExist();
  const now = Date.now();
  return Array.from(tournaments.values())
    .filter(t => t.startTime >= now - 60 * 60 * 1000) // keep last hour too
    .sort((a, b) => a.startTime - b.startTime)
    .map(t => ({
      id: t.id,
      startTime: t.startTime,
      playerCount: t.players.length,
      maxPlayers: MAX_PLAYERS,
      status: t.status,
      winners: t.winners
    }));
}

// Check every 10s if any tournament should start
setInterval(() => {
  ensureTournamentsExist();
  const now = Date.now();
  for (const t of tournaments.values()) {
    if (t.status === 'registering' && now >= t.startTime) {
      startTournament(t);
    }
  }
  // Broadcast updated tournament list
  io.emit('tournamentList', getPublicTournaments());
}, 10000);

function startTournament(t) {
  t.status = 'inProgress';

  // Fill empty seats with bots
  const seats = [...t.players];
  let botIdx = 0;
  while (seats.length < MAX_PLAYERS) {
    const name = BOT_NAMES[botIdx % BOT_NAMES.length];
    seats.push({
      id: `bot_${t.id}_${botIdx}`,
      name,
      avatar: BOT_AVATARS[botIdx % BOT_AVATARS.length],
      chips: CHIPS_START,
      eliminated: false,
      card: null,
      seatIndex: seats.length,
      isBot: true
    });
    botIdx++;
  }

  // Reset human players
  seats.forEach(p => { p.chips = CHIPS_START; p.eliminated = false; p.card = null; });

  // Notify registered players the tournament is starting
  t.players.forEach(p => {
    io.to(p.id).emit('tournamentStarting', { tournamentId: t.id });
  });

  // Store full player list and start
  t.allPlayers = seats;
  t.gameState = null;
  startTournamentGame(t);
}

// ─────────────────────────────────────────
//  SHARED GAME LOGIC
// ─────────────────────────────────────────
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardValue(card) { return RANK_VALUE[card?.rank] ?? 99; }

function alivePlayers(playerList) {
  return playerList.filter(p => !p.eliminated && p.chips > 0);
}

function nextAliveIndex(playerList, from, step = 1) {
  const n = playerList.length;
  let idx = from;
  for (let i = 0; i < n * 2; i++) {
    idx = ((idx + step) % n + n) % n;
    const p = playerList[idx];
    if (p && !p.eliminated && p.chips > 0) return idx;
  }
  return -1;
}

// Emit game state — each player only sees their own card
function broadcastGameState(playerList, gs, roomOrTournamentId, isTournament = false) {
  playerList.forEach(player => {
    if (player.isBot) return;
    const sanitized = playerList.map(p => ({
      id: p.id, name: p.name, chips: p.chips,
      eliminated: p.eliminated, seatIndex: p.seatIndex,
      isBot: p.isBot, avatar: p.avatar,
      card: (p.id === player.id || p.card?.rank === 'K') ? p.card : (p.card ? 'hidden' : null)
    }));
    io.to(player.id).emit('gameState', {
      players: sanitized,
      currentIndex: gs.currentIndex,
      currentPlayerId: playerList[gs.currentIndex]?.id,
      phase: gs.phase,
      isTournament,
      tournamentId: isTournament ? roomOrTournamentId : null
    });
  });
}

// ─────────────────────────────────────────
//  ROOM GAME FLOW
// ─────────────────────────────────────────
function startGame(room) {
  const gs = { deck: [], dealerIndex: 0, currentIndex: 0, turnsTaken: 0, phase: 'playing', botTimer: null };
  room.gameState = gs;
  room.players.forEach(p => { p.chips = CHIPS_START; p.eliminated = false; p.card = null; });
  startRound(room);
}

function startRound(room) {
  const gs = room.gameState;
  if (!gs) return;
  clearBotTimer(gs);
  gs.deck = makeDeck();
  gs.turnsTaken = 0;
  gs.phase = 'playing';
  alivePlayers(room.players).forEach(p => { p.card = gs.deck.pop(); });
  gs.currentIndex = nextAliveIndex(room.players, gs.dealerIndex, 1);
  broadcastGameState(room.players, gs, room.code, false);
  scheduleIfBot(gs, room.players, () => botAct(room));
}

function endRound(room) {
  const gs = room.gameState;
  clearBotTimer(gs);
  gs.phase = 'roundEnd';
  const alive = alivePlayers(room.players);
  const minVal = Math.min(...alive.map(p => cardValue(p.card)));
  const losers = alive.filter(p => cardValue(p.card) === minVal);
  losers.forEach(p => { p.chips--; if (p.chips <= 0) p.eliminated = true; });
  io.to(room.code).emit('roundEnded', { players: room.players, losers: losers.map(p => ({ name: p.name, card: p.card })) });
  const stillAlive = alivePlayers(room.players);
  if (stillAlive.length <= 1) {
    const winner = stillAlive[0] || room.players[0];
    io.to(room.code).emit('gameOver', { winner: { name: winner.name } });
    room.gameState = null;
    return;
  }
  setTimeout(() => {
    if (!room.gameState) return;
    gs.dealerIndex = nextAliveIndex(room.players, gs.dealerIndex, 1);
    room.players.forEach(p => p.card = null);
    startRound(room);
  }, 5000);
}

function advanceTurn(room) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;
  gs.turnsTaken++;
  if (gs.turnsTaken >= alivePlayers(room.players).length) { endRound(room); return; }
  gs.currentIndex = nextAliveIndex(room.players, gs.currentIndex, 1);
  broadcastGameState(room.players, gs, room.code, false);
  scheduleIfBot(gs, room.players, () => botAct(room));
}

function handleKeep(room) { advanceTurn(room); }

function handlePass(room) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;
  const fromIdx = gs.currentIndex;
  const toIdx = nextAliveIndex(room.players, fromIdx, 1);
  const fromP = room.players[fromIdx];
  const toP = room.players[toIdx];
  if (!fromP || !toP) return;
  if (fromP.card?.rank === 'K') return handleKeep(room);
  if (toP.card?.rank === 'K') {
    io.to(room.code).emit('kingBlocked', { blockerName: toP.name });
    setTimeout(() => handleKeep(room), 1200);
    return;
  }
  [fromP.card, toP.card] = [toP.card, fromP.card];
  io.to(room.code).emit('cardPassed', { fromIndex: fromIdx, toIndex: toIdx });
  advanceTurn(room);
}

function botAct(room) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;
  const cur = room.players[gs.currentIndex];
  if (!cur?.isBot) return;
  const val = cardValue(cur.card);
  const toIdx = nextAliveIndex(room.players, gs.currentIndex, 1);
  const toP = room.players[toIdx];
  const blocked = toP?.card?.rank === 'K' || cur.card?.rank === 'K';
  const wantPass = !blocked && (val <= 4 || (val <= 8 && Math.random() < 0.55));
  if (wantPass) handlePass(room);
  else handleKeep(room);
}

// ─────────────────────────────────────────
//  TOURNAMENT GAME FLOW
// ─────────────────────────────────────────
function startTournamentGame(t) {
  const gs = { deck: [], dealerIndex: 0, currentIndex: 0, turnsTaken: 0, phase: 'playing', botTimer: null };
  t.gameState = gs;
  startTournamentRound(t);
}

function startTournamentRound(t) {
  const gs = t.gameState;
  if (!gs) return;
  clearBotTimer(gs);
  gs.deck = makeDeck();
  gs.turnsTaken = 0;
  gs.phase = 'playing';
  alivePlayers(t.allPlayers).forEach(p => { p.card = gs.deck.pop(); });
  gs.currentIndex = nextAliveIndex(t.allPlayers, gs.dealerIndex, 1);
  broadcastGameState(t.allPlayers, gs, t.id, true);
  scheduleIfBot(gs, t.allPlayers, () => tournamentBotAct(t));
}

function endTournamentRound(t) {
  const gs = t.gameState;
  clearBotTimer(gs);
  gs.phase = 'roundEnd';
  const alive = alivePlayers(t.allPlayers);
  const minVal = Math.min(...alive.map(p => cardValue(p.card)));
  const losers = alive.filter(p => cardValue(p.card) === minVal);
  losers.forEach(p => { p.chips--; if (p.chips <= 0) p.eliminated = true; });

  t.allPlayers.filter(p => !p.isBot).forEach(player => {
    const sanitized = t.allPlayers.map(p => ({
      id: p.id, name: p.name, chips: p.chips, eliminated: p.eliminated,
      seatIndex: p.seatIndex, isBot: p.isBot, avatar: p.avatar,
      card: p.card
    }));
    io.to(player.id).emit('roundEnded', { players: sanitized, losers: losers.map(p => ({ name: p.name, card: p.card })) });
  });

  const stillAlive = alivePlayers(t.allPlayers);
  if (stillAlive.length <= 1) {
    const winner = stillAlive[0] || t.allPlayers[0];
    t.status = 'finished';
    t.winners = [winner.name];
    t.allPlayers.filter(p => !p.isBot).forEach(player => {
      io.to(player.id).emit('gameOver', { winner: { name: winner.name }, isTournament: true });
    });
    io.emit('tournamentList', getPublicTournaments());
    return;
  }

  setTimeout(() => {
    if (!t.gameState) return;
    gs.dealerIndex = nextAliveIndex(t.allPlayers, gs.dealerIndex, 1);
    t.allPlayers.forEach(p => p.card = null);
    startTournamentRound(t);
  }, 5000);
}

function advanceTournamentTurn(t) {
  const gs = t.gameState;
  if (!gs || gs.phase !== 'playing') return;
  gs.turnsTaken++;
  if (gs.turnsTaken >= alivePlayers(t.allPlayers).length) { endTournamentRound(t); return; }
  gs.currentIndex = nextAliveIndex(t.allPlayers, gs.currentIndex, 1);
  broadcastGameState(t.allPlayers, gs, t.id, true);
  scheduleIfBot(gs, t.allPlayers, () => tournamentBotAct(t));
}

function tournamentBotAct(t) {
  const gs = t.gameState;
  if (!gs || gs.phase !== 'playing') return;
  const cur = t.allPlayers[gs.currentIndex];
  if (!cur?.isBot) return;
  const val = cardValue(cur.card);
  const toIdx = nextAliveIndex(t.allPlayers, gs.currentIndex, 1);
  const toP = t.allPlayers[toIdx];
  const blocked = toP?.card?.rank === 'K' || cur.card?.rank === 'K';
  const wantPass = !blocked && (val <= 4 || (val <= 8 && Math.random() < 0.55));
  if (wantPass) {
    const fromP = t.allPlayers[gs.currentIndex];
    if (fromP.card?.rank !== 'K' && toP.card?.rank !== 'K') {
      [fromP.card, toP.card] = [toP.card, fromP.card];
    }
  }
  advanceTournamentTurn(t);
}

// ─────────────────────────────────────────
//  SHARED BOT SCHEDULING
// ─────────────────────────────────────────
function scheduleIfBot(gs, playerList, actFn) {
  const cur = playerList[gs.currentIndex];
  if (!cur?.isBot) return;
  gs.botTimer = setTimeout(() => actFn(), BOT_DELAY_MS);
}

function clearBotTimer(gs) {
  if (gs?.botTimer) { clearTimeout(gs.botTimer); gs.botTimer = null; }
}

// ─────────────────────────────────────────
//  SOCKET EVENTS
// ─────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  // Send initial data
  socket.emit('tournamentList', getPublicTournaments());
  socket.emit('lobbyUpdate', getLobbyRooms());

  // ── Tournament registration
  socket.on('registerTournament', ({ tournamentId, name, avatar }) => {
    const t = tournaments.get(tournamentId);
    if (!t) { socket.emit('error', 'Tournament not found.'); return; }
    if (t.status !== 'registering') { socket.emit('error', 'Registration is closed.'); return; }
    if (t.players.length >= MAX_PLAYERS) { socket.emit('error', 'Tournament is full.'); return; }
    if (t.players.find(p => p.id === socket.id)) { socket.emit('error', 'Already registered.'); return; }

    const player = { id: socket.id, name, avatar: avatar || '🎭', chips: CHIPS_START, eliminated: false, card: null, seatIndex: t.players.length, isBot: false };
    t.players.push(player);
    socket.join(tournamentId);
    socket.data.tournamentId = tournamentId;
    socket.data.playerName = name;
    socket.data.playerAvatar = avatar;

    socket.emit('registeredTournament', { tournamentId, playerCount: t.players.length });
    io.emit('tournamentList', getPublicTournaments());
  });

  socket.on('unregisterTournament', ({ tournamentId }) => {
    const t = tournaments.get(tournamentId);
    if (!t || t.status !== 'registering') return;
    t.players = t.players.filter(p => p.id !== socket.id);
    socket.leave(tournamentId);
    socket.data.tournamentId = null;
    io.emit('tournamentList', getPublicTournaments());
  });

  // ── Tournament in-game actions
  socket.on('tournamentKeep', () => {
    const tid = socket.data.activeTournamentId;
    const t = tid && tournaments.get(tid);
    if (!t?.gameState) return;
    const cur = t.allPlayers[t.gameState.currentIndex];
    if (cur?.id !== socket.id) return;
    clearBotTimer(t.gameState);
    advanceTournamentTurn(t);
  });

  socket.on('tournamentPass', () => {
    const tid = socket.data.activeTournamentId;
    const t = tid && tournaments.get(tid);
    if (!t?.gameState) return;
    const gs = t.gameState;
    const cur = t.allPlayers[gs.currentIndex];
    if (cur?.id !== socket.id) return;
    clearBotTimer(gs);
    const toIdx = nextAliveIndex(t.allPlayers, gs.currentIndex, 1);
    const toP = t.allPlayers[toIdx];
    if (cur.card?.rank === 'K') { advanceTournamentTurn(t); return; }
    if (toP?.card?.rank === 'K') {
      t.allPlayers.filter(p => !p.isBot).forEach(p => io.to(p.id).emit('kingBlocked', { blockerName: toP.name }));
      setTimeout(() => advanceTournamentTurn(t), 1200);
      return;
    }
    [cur.card, toP.card] = [toP.card, cur.card];
    advanceTournamentTurn(t);
  });

  // When tournament starts, move player to active game
  socket.on('readyForTournament', ({ tournamentId }) => {
    socket.data.activeTournamentId = tournamentId;
  });

  // ── Room events
  socket.on('createRoom', ({ name, seats, mode, avatar }) => {
    const code = Math.random().toString(36).slice(2,8).toUpperCase();
    const room = makeRoom(code, { seats: seats || 6, mode: mode || 'Classic' });
    rooms.set(code, room);
    const player = { id: socket.id, name, chips: CHIPS_START, eliminated: false, card: null, seatIndex: 0, isBot: false, avatar: avatar || '🎭' };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('roomCreated', { code, players: room.players });
    io.emit('lobbyUpdate', getLobbyRooms());
  });

  socket.on('joinRoom', ({ name, code, avatar }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('error', 'Room not found.'); return; }
    if (room.gameState) { socket.emit('error', 'Game already in progress.'); return; }
    if (room.players.length >= (room.options.seats || 8)) { socket.emit('error', 'Room is full.'); return; }
    const player = { id: socket.id, name, chips: CHIPS_START, eliminated: false, card: null, seatIndex: room.players.length, isBot: false, avatar: avatar || '🎭' };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('joinedRoom', { code, players: room.players });
    io.to(code).emit('playerList', room.players);
    io.emit('lobbyUpdate', getLobbyRooms());
  });

  socket.on('startGame', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    let botCount = 0;
    while (room.players.length < (room.options.seats || 6)) {
      room.players.push({ id: `bot_${Date.now()}_${botCount}`, name: BOT_NAMES[botCount % BOT_NAMES.length], chips: CHIPS_START, eliminated: false, card: null, seatIndex: room.players.length, isBot: true, avatar: BOT_AVATARS[botCount % BOT_AVATARS.length] });
      botCount++;
    }
    startGame(room);
    io.emit('lobbyUpdate', getLobbyRooms());
  });

  socket.on('keep', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room?.gameState) return;
    const cur = room.players[room.gameState.currentIndex];
    if (cur?.id !== socket.id) return;
    clearBotTimer(room.gameState);
    handleKeep(room);
  });

  socket.on('pass', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room?.gameState) return;
    const cur = room.players[room.gameState.currentIndex];
    if (cur?.id !== socket.id) return;
    clearBotTimer(room.gameState);
    handlePass(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (code) {
      const room = getRoom(code);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) rooms.delete(code);
        else io.to(code).emit('playerList', room.players);
        io.emit('lobbyUpdate', getLobbyRooms());
      }
    }
    const tid = socket.data.tournamentId;
    if (tid) {
      const t = tournaments.get(tid);
      if (t && t.status === 'registering') {
        t.players = t.players.filter(p => p.id !== socket.id);
        io.emit('tournamentList', getPublicTournaments());
      }
    }
  });
});

function getLobbyRooms() {
  return Array.from(rooms.values())
    .filter(r => r.players.length > 0)
    .map(r => ({ code: r.code, playerCount: r.players.length, maxPlayers: r.options.seats || 8, inProgress: !!r.gameState, mode: r.options.mode || 'Classic' }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
