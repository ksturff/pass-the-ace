const express = require('express');
const http = require('http');
const https = require('https');
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
const MAX_PLAYERS_MICRO    = 10;
const MAX_PLAYERS_DAILY    = 50;
const MAX_PLAYERS_SATURDAY = 200;
const TOURNAMENT_INTERVAL_MS = 15 * 60 * 1000;
const BOT_NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery','Blake'];
const BOT_AVATARS = ['🐺','🦁','🐯','🦅','🐉','🦈','👾','🤖','💀','🦂'];

// ─────────────────────────────────────────
//  SELF-PING — keeps Render free tier alive
// ─────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;
if (RENDER_URL) {
  setInterval(() => {
    https.get(`${RENDER_URL}/health`, (res) => {
      console.log(`[ping] ${res.statusCode}`);
    }).on('error', (e) => {
      console.warn('[ping error]', e.message);
    });
  }, 10 * 60 * 1000); // ping every 10 minutes
  console.log(`Self-ping active → ${RENDER_URL}/health`);
}

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

// Returns array of { startTime, type } for all upcoming slots
function getAllTournamentSlots(count = 200) {
  const slots = [];
  const now = Date.now();

  // ── MICRO: every 15 minutes ──
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const firstMicro = Math.ceil(startOfDay.getTime() / TOURNAMENT_INTERVAL_MS) * TOURNAMENT_INTERVAL_MS;
  for (let i = 0; i < count; i++) {
    slots.push({ startTime: firstMicro + i * TOURNAMENT_INTERVAL_MS, type: 'micro' });
  }

  // ── DAILY: 2pm, 6pm, 10pm — next 14 days ──
  const dailyHours = [14, 18, 22];
  for (let d = 0; d < 14; d++) {
    const base = new Date(startOfDay.getTime() + d * 86400000);
    dailyHours.forEach(hr => {
      const t = new Date(base); t.setHours(hr, 0, 0, 0);
      slots.push({ startTime: t.getTime(), type: 'daily' });
    });
  }

  // ── SATURDAY: 12pm, 3pm, 6pm, 9pm — next 8 Saturdays ──
  const satHours = [12, 15, 18, 21];
  for (let w = 0; w < 8; w++) {
    const daysUntilSat = (6 - startOfDay.getDay() + 7) % 7 + w * 7;
    const sat = new Date(startOfDay.getTime() + daysUntilSat * 86400000);
    satHours.forEach(hr => {
      const t = new Date(sat); t.setHours(hr, 0, 0, 0);
      slots.push({ startTime: t.getTime(), type: 'saturday' });
    });
  }

  return slots;
}

function getTournamentId(startTime, type) {
  return `${type}_${startTime}`;
}

function maxPlayersForType(type) {
  if (type === 'daily')    return MAX_PLAYERS_DAILY;
  if (type === 'saturday') return MAX_PLAYERS_SATURDAY;
  return MAX_PLAYERS_MICRO;
}

function ensureTournamentsExist() {
  const slots = getAllTournamentSlots(200);
  slots.forEach(({ startTime, type }) => {
    const id = getTournamentId(startTime, type);
    if (!tournaments.has(id)) {
      tournaments.set(id, {
        id,
        startTime,
        type,                  // 'micro' | 'daily' | 'saturday'
        players: [],
        gameState: null,
        status: 'registering',
        winners: [],
        placements: {}         // socketId -> placement number
      });
    }
  });
  // Clean up tournaments older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, t] of tournaments.entries()) {
    if (t.startTime < cutoff) tournaments.delete(id);
  }
}

function getPublicTournaments() {
  ensureTournamentsExist();
  const now = Date.now();
  return Array.from(tournaments.values())
    .filter(t => t.startTime >= now - 60 * 60 * 1000)
    .sort((a, b) => a.startTime - b.startTime)
    .map(t => ({
      id: t.id,
      startTime: t.startTime,
      type: t.type,
      playerCount: t.players.length,
      maxPlayers: maxPlayersForType(t.type),
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
  t.placements = {};
  t.eliminationOrder = []; // track order eliminated

  const maxPlayers = maxPlayersForType(t.type);

  // Fill empty seats with bots (micro only — daily/saturday need real players)
  const seats = [...t.players];
  if (t.type === 'micro') {
    let botIdx = 0;
    while (seats.length < maxPlayers) {
      seats.push({
        id: `bot_${t.id}_${botIdx}`,
        name: BOT_NAMES[botIdx % BOT_NAMES.length],
        avatar: BOT_AVATARS[botIdx % BOT_AVATARS.length],
        chips: CHIPS_START, eliminated: false, card: null,
        seatIndex: seats.length, isBot: true
      });
      botIdx++;
    }
  }

  seats.forEach(p => { p.chips = CHIPS_START; p.eliminated = false; p.card = null; });

  t.players.forEach(p => {
    io.to(p.id).emit('tournamentStarting', { tournamentId: t.id, tournamentType: t.type });
  });

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
  losers.forEach(p => {
    p.chips--;
    if (p.chips <= 0) {
      p.eliminated = true;
      // Track elimination order for placement
      if (!t.eliminationOrder) t.eliminationOrder = [];
      t.eliminationOrder.push(p.id);
    }
  });

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

    // Build placements map: socketId -> finishing position
    // Winner = 1, then reverse elimination order
    const humanPlayers = t.allPlayers.filter(p => !p.isBot);
    const totalHumans = humanPlayers.length;
    const placements = {};
    placements[winner.id] = 1;
    const eliminated = (t.eliminationOrder || []).filter(id =>
      humanPlayers.find(p => p.id === id)
    );
    eliminated.reverse().forEach((id, idx) => {
      placements[id] = idx + 2; // 2nd, 3rd, 4th...
    });

    t.allPlayers.filter(p => !p.isBot).forEach(player => {
      io.to(player.id).emit('gameOver', {
        winner: { name: winner.name, id: winner.id },
        isTournament: true,
        tournamentType: t.type,
        placements
      });
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

  // ── Client requests tournament list explicitly
  socket.on('getTournaments', () => {
    socket.emit('tournamentList', getPublicTournaments());
  });

  // ── Tournament registration
  socket.on('registerTournament', ({ tournamentId, name, avatar, ticketType }) => {
    const t = tournaments.get(tournamentId);
    if (!t) { socket.emit('error', 'Tournament not found.'); return; }
    if (t.status !== 'registering') { socket.emit('error', 'Registration is closed.'); return; }
    if (t.players.length >= maxPlayersForType(t.type)) { socket.emit('error', 'Tournament is full.'); return; }
    if (t.players.find(p => p.id === socket.id)) { socket.emit('error', 'Already registered.'); return; }

    // Ticket-gated tournaments: client already spent the ticket via Firestore
    // Server just validates the type matches
    if (t.type === 'daily' && ticketType !== 'daily') {
      socket.emit('error', 'Daily Ticket required.'); return;
    }
    if (t.type === 'saturday' && ticketType !== 'saturday') {
      socket.emit('error', 'Saturday Ticket required.'); return;
    }

    const player = {
      id: socket.id, name, avatar: avatar || '🎭',
      chips: CHIPS_START, eliminated: false, card: null,
      seatIndex: t.players.length, isBot: false
    };
    t.players.push(player);
    socket.join(tournamentId);
    socket.data.tournamentId = tournamentId;
    socket.data.tournamentType = t.type;
    socket.data.playerName = name;
    socket.data.playerAvatar = avatar;

    socket.emit('registeredTournament', { tournamentId, tournamentType: t.type, playerCount: t.players.length });
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

// Generate tournament schedule on startup
ensureTournamentsExist();
const counts = { micro: 0, daily: 0, saturday: 0 };
for (const t of tournaments.values()) counts[t.type] = (counts[t.type] || 0) + 1;
console.log(`Tournaments generated → micro: ${counts.micro}, daily: ${counts.daily}, saturday: ${counts.saturday}`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
