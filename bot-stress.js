/**
 * bot-stress.js
 * Spawns N bots that register for a daily satellite tournament.
 * Run: node bot-stress.js [serverUrl] [numBots] [tournamentId]
 *
 * Examples:
 *   node bot-stress.js                                      <- 240 bots, localhost:3000, auto-picks next daily
 *   node bot-stress.js http://localhost:3000 100            <- 100 bots, localhost
 *   node bot-stress.js http://localhost:3000 240 daily_xxx <- specific tournament ID
 */

const { io } = require('socket.io-client');

const SERVER_URL  = process.argv[2] || 'http://localhost:3000';
const NUM_BOTS    = parseInt(process.argv[3] || '240', 10);
const FIXED_TID   = process.argv[4] || null;   // optional: force a specific tournament ID

const BOT_NAMES   = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery','Blake',
                     'Drew','Skyler','Jamie','Reese','Finley','Rowan','Sage','Blair','Emery','Phoenix'];
const BOT_AVATARS = ['🐺','🦁','🐯','🦅','🐉','🦈','👾','🤖','💀','🦂','🐸','🦊','🐻','🦝','🐼','🦋','🐝','🦎','🐬','🦜'];

// ── Stats tracked for the dashboard ──────────────────────────────────────────
const stats = {
  connected:    0,
  registered:   0,
  playing:      0,
  eliminated:   0,
  advanced:     0,   // advanced to final table
  finalists:    0,
  errors:       0,
  tableMap:     {},  // tableId -> { players, eliminated }
  log:          [],
};

function addLog(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  stats.log.push(line);
  if (stats.log.length > 200) stats.log.shift();
  console.log(line);
}

// ── Find the next available daily tournament ──────────────────────────────────
function findDailyTournament(list) {
  return list
    .filter(t => t.type === 'daily' && t.status === 'registering')
    .sort((a, b) => a.startTime - b.startTime)[0] || null;
}

// ── Spawn a single bot ────────────────────────────────────────────────────────
function spawnBot(index, tournamentId) {
  const name   = BOT_NAMES[index % BOT_NAMES.length] + '_' + index;
  const avatar = BOT_AVATARS[index % BOT_AVATARS.length];

  const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
  let myActiveTid = null;

  socket.on('connect', () => {
    stats.connected++;

    // If we already know the tournament ID, register immediately
    if (tournamentId) {
      register(tournamentId);
    }
    // Otherwise wait for the tournament list
    socket.on('tournamentList', (list) => {
      if (myActiveTid) return; // already registered
      const t = findDailyTournament(list);
      if (t) register(t.id);
    });
  });

  function register(tid) {
    if (myActiveTid) return;
    myActiveTid = tid;
    socket.emit('registerTournament', { tournamentId: tid, name, avatar });
  }

  socket.on('registeredTournament', ({ tournamentId }) => {
    stats.registered++;
    if (stats.registered % 50 === 0) addLog(`📋 ${stats.registered} bots registered`);
  });

  socket.on('tournamentStarting', ({ tournamentId, tournamentType, tableNumber, totalTables }) => {
    stats.playing++;
    socket.data = socket.data || {};
    socket.emit('readyForTournament', { tournamentId });
    socket.data.activeTid = tournamentId;

    // Track table
    if (!stats.tableMap[tournamentId]) {
      stats.tableMap[tournamentId] = { players: 0, eliminated: 0, type: tournamentType };
      addLog(`🃏 Table started: ${tournamentId} (${tournamentType}${tableNumber ? ` — Table ${tableNumber}/${totalTables}` : ''})`);
    }
    stats.tableMap[tournamentId].players++;
  });

  socket.on('advancingToFinal', ({ tournamentId }) => {
    stats.advanced++;
    addLog(`⭐ Bot advanced to Final Table! (total advanced: ${stats.advanced})`);
  });

  socket.on('gameState', (state) => {
    const tid = socket.data?.activeTid;
    if (!tid) return;

    // If it's this bot's turn, act
    if (state.currentPlayerId === socket.id) {
      setTimeout(() => {
        // Simple strategy: pass if low card value, keep otherwise
        const me = state.players.find(p => p.id === socket.id);
        const cardVal = me?.card && me.card !== 'hidden'
          ? { 2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:1 }[me.card.rank] || 7
          : 7;
        const shouldPass = cardVal <= 6 && Math.random() < 0.7;
        socket.emit(shouldPass ? 'tournamentPass' : 'tournamentKeep');
      }, 200 + Math.random() * 300); // small random delay so not all bots fire at once
    }
  });

  socket.on('tournamentResult', (data) => {
    const tid = socket.data?.activeTid;
    stats.eliminated++;
    if (stats.tableMap[tid]) stats.tableMap[tid].eliminated++;
    socket.disconnect();
  });

  socket.on('error', (msg) => {
    stats.errors++;
    if (stats.errors <= 10) addLog(`❌ Error (bot ${index}): ${msg}`);
  });

  socket.on('disconnect', () => {
    stats.connected--;
  });

  socket.on('connect_error', (err) => {
    stats.errors++;
    if (stats.errors <= 5) addLog(`🔌 Connect error: ${err.message}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  addLog(`🚀 Stress test starting — ${NUM_BOTS} bots → ${SERVER_URL}`);
  if (FIXED_TID) addLog(`📌 Targeting tournament: ${FIXED_TID}`);

  // Stagger bot spawns so we don't hammer the server all at once
  // 240 bots spawned over ~5 seconds (one every ~20ms)
  for (let i = 0; i < NUM_BOTS; i++) {
    spawnBot(i, FIXED_TID);
    await new Promise(r => setTimeout(r, 20));
  }

  addLog(`✅ All ${NUM_BOTS} bots spawned`);

  // Print a summary every 15 seconds
  setInterval(() => {
    const tableCount  = Object.keys(stats.tableMap).length;
    const activeTables = Object.values(stats.tableMap).filter(t => t.eliminated < t.players).length;
    addLog(`📊 Summary — connected:${stats.connected} registered:${stats.registered} playing:${stats.playing} eliminated:${stats.eliminated} advanced:${stats.advanced} tables:${tableCount} active:${activeTables} errors:${stats.errors}`);
  }, 15000);
}

main().catch(console.error);
