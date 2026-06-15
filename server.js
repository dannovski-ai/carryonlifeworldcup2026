'use strict';

const express   = require('express');
const http      = require('http');
const { Server} = require('socket.io');
const fs        = require('fs');
const path      = require('path');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

const PORT      = parseInt(process.env.PORT) || 3000;
const API_KEY   = process.env.FOOTBALL_API_KEY || '';
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

// ── Fixture name lookup (used to map API responses → our match IDs) ─────────
// Format: "Home|Away" → matchId (e.g. "A_0")
const FIXTURE_LOOKUP = {};
const FIXTURE_NAMES = [
  ['A','Mexico','South Africa'],['A','South Korea','Czechia'],
  ['A','Mexico','Czechia'],['A','South Korea','South Africa'],
  ['A','Mexico','South Korea'],['A','South Africa','Czechia'],
  ['B','Canada','Bosnia'],['B','Switzerland','Qatar'],
  ['B','Canada','Qatar'],['B','Switzerland','Bosnia'],
  ['B','Canada','Switzerland'],['B','Bosnia','Qatar'],
  ['C','Brazil','Scotland'],['C','Morocco','Haiti'],
  ['C','Brazil','Haiti'],['C','Morocco','Scotland'],
  ['C','Brazil','Morocco'],['C','Scotland','Haiti'],
  ['D','USA','Paraguay'],['D','Australia','Turkey'],
  ['D','USA','Turkey'],['D','Australia','Paraguay'],
  ['D','USA','Australia'],['D','Paraguay','Turkey'],
  ['E','Germany','Ivory Coast'],['E','Ecuador','Curaçao'],
  ['E','Germany','Curaçao'],['E','Ecuador','Ivory Coast'],
  ['E','Germany','Ecuador'],['E','Ivory Coast','Curaçao'],
  ['F','Netherlands','Tunisia'],['F','Japan','Sweden'],
  ['F','Netherlands','Sweden'],['F','Japan','Tunisia'],
  ['F','Netherlands','Japan'],['F','Tunisia','Sweden'],
  ['G','Belgium','New Zealand'],['G','Iran','Egypt'],
  ['G','Belgium','Egypt'],['G','Iran','New Zealand'],
  ['G','Belgium','Iran'],['G','Egypt','New Zealand'],
  ['H','Spain','Saudi Arabia'],['H','Uruguay','Cape Verde'],
  ['H','Spain','Cape Verde'],['H','Uruguay','Saudi Arabia'],
  ['H','Spain','Uruguay'],['H','Saudi Arabia','Cape Verde'],
  ['I','France','Iraq'],['I','Senegal','Norway'],
  ['I','France','Norway'],['I','Senegal','Iraq'],
  ['I','France','Senegal'],['I','Norway','Iraq'],
  ['J','Argentina','Jordan'],['J','Austria','Algeria'],
  ['J','Argentina','Algeria'],['J','Austria','Jordan'],
  ['J','Argentina','Austria'],['J','Algeria','Jordan'],
  ['K','Portugal','DR Congo'],['K','Colombia','Uzbekistan'],
  ['K','Portugal','Uzbekistan'],['K','Colombia','DR Congo'],
  ['K','Portugal','Colombia'],['K','Uzbekistan','DR Congo'],
  ['L','England','Panama'],['L','Croatia','Ghana'],
  ['L','England','Ghana'],['L','Croatia','Panama'],
  ['L','England','Croatia'],['L','Panama','Ghana'],
];

const groupCounters = {};
FIXTURE_NAMES.forEach(([g, home, away]) => {
  groupCounters[g] = (groupCounters[g] || 0);
  const id = `${g}_${groupCounters[g]++}`;
  FIXTURE_LOOKUP[`${home}|${away}`] = id;
});

// Knockout match IDs used in the frontend
const KO_IDS = [
  'R32-M1','R32-M2','R32-M3','R32-M4','R32-M5','R32-M6','R32-M7','R32-M8',
  'R32-M9','R32-M10','R32-M11','R32-M12','R32-M13','R32-M14','R32-M15','R32-M16',
  'R16-M1','R16-M2','R16-M3','R16-M4','R16-M5','R16-M6','R16-M7','R16-M8',
  'QF1','QF2','QF3','QF4','SF1','SF2','3PO','FINAL',
];

// Team name normalisations (API names → our names)
const NAME_MAP = {
  'Czech Republic':                    'Czechia',
  'Bosnia and Herzegovina':            'Bosnia',
  'Bosnia-Herzegovina':                'Bosnia',
  'Korea Republic':                    'South Korea',
  "Côte d'Ivoire":                     'Ivory Coast',
  'Congo DR':                          'DR Congo',
  'Democratic Republic of the Congo':  'DR Congo',
  'Curacao':                           'Curaçao',
  'United States':                     'USA',
  'Cape Verde Islands':                'Cape Verde',
};
const norm = n => NAME_MAP[n] || n;

// ── All 48 tournament teams (for sweepstake draw) ────────────────────────────
const ALL_TEAMS = [
  'Mexico','South Korea','South Africa','Czechia',
  'Canada','Switzerland','Qatar','Bosnia',
  'Brazil','Morocco','Scotland','Haiti',
  'USA','Australia','Paraguay','Turkey',
  'Germany','Ecuador','Ivory Coast','Curaçao',
  'Netherlands','Japan','Tunisia','Sweden',
  'Belgium','Iran','Egypt','New Zealand',
  'Spain','Uruguay','Saudi Arabia','Cape Verde',
  'France','Senegal','Norway','Iraq',
  'Argentina','Austria','Algeria','Jordan',
  'Portugal','Colombia','Uzbekistan','DR Congo',
  'England','Croatia','Panama','Ghana',
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  players:     [],   // string[]
  predictions: {},   // { playerName: { matchId: { h, a } } }
  results:     {},   // { matchId: { h, a } }   — final scores only
  live:        {},   // { matchId: { h, a, status } } — in-play, not counted
  sweepstake:  {
    drawn:       false,
    assignments: {},   // { playerName: [team, team, team] }
    eliminated:  [],   // [teamName, …] — manually marked out
  },
};

function loadState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = { ...state, ...loaded };
    }
  } catch (e) {
    console.error('Could not load state:', e.message);
  }
}

function persistState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Could not persist state:', e.message);
  }
}

// ── football-data.org score polling ──────────────────────────────────────────
async function fetchScores() {
  if (!API_KEY) return;
  try {
    const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': API_KEY },
    });

    if (res.status === 403) {
      console.warn('API key rejected (403). Check FOOTBALL_API_KEY.');
      return;
    }
    if (!res.ok) {
      console.warn(`Score API returned ${res.status}`);
      return;
    }

    const data = await res.json();
    let changed = false;
    const newLive = {};

    for (const match of (data.matches || [])) {
      const home = norm(match.homeTeam?.name || '');
      const away = norm(match.awayTeam?.name || '');
      // Try both home|away and away|home since API home/away can differ from our fixture list
      const id = FIXTURE_LOOKUP[`${home}|${away}`] || FIXTURE_LOOKUP[`${away}|${home}`];
      if (!id) {
        console.log(`⚠ No fixture match for: ${home} vs ${away}`);
        continue;
      }

      const ft  = match.score?.fullTime;
      const ht  = match.score?.halfTime;

      if (match.status === 'FINISHED' && ft?.home != null && ft?.away != null) {
        const prev = state.results[id];
        if (!prev || prev.h !== ft.home || prev.a !== ft.away) {
          state.results[id] = { h: ft.home, a: ft.away };
          delete state.live[id];
          changed = true;
          console.log(`✓ FT  ${home} ${ft.home}–${ft.away} ${away}`);
        }
      } else if (['IN_PLAY', 'PAUSED', 'HALF_TIME'].includes(match.status)) {
        const cur = match.status === 'HALF_TIME' ? ht : ft;
        if (cur?.home != null && cur?.away != null) {
          const prev = state.live[id];
          if (!prev || prev.h !== cur.home || prev.a !== cur.away || prev.status !== match.status) {
            newLive[id] = { h: cur.home, a: cur.away, status: match.status };
            changed = true;
            console.log(`⚽ LIVE ${home} ${cur.home}–${cur.away} ${away} [${match.status}]`);
          } else {
            newLive[id] = prev; // keep unchanged
          }
        }
      }
    }

    const liveChanged = JSON.stringify(state.live) !== JSON.stringify(newLive);
    if (liveChanged) { state.live = newLive; changed = true; }

    if (changed) {
      persistState();
      io.emit('state_update', state);
      console.log(`Broadcast state_update — ${Object.keys(state.results).length} results, ${Object.keys(state.live).length} live`);
    }
  } catch (e) {
    console.error('fetchScores error:', e.message);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────
const ADMIN_NAME = 'dan stead';
const isAdmin = name => typeof name === 'string' && name.trim().toLowerCase() === ADMIN_NAME;

// ── Socket.io handlers ────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`+ client ${socket.id}`);

  // Send full state on connect
  socket.emit('state', state);

  socket.on('add_player', name => {
    name = (typeof name === 'string') ? name.trim().slice(0, 30) : '';
    if (!name) return;
    if (!state.players.includes(name)) {
      state.players.push(name);
      state.predictions[name] = state.predictions[name] || {};
    }
    persistState();
    io.emit('state_update', state);
  });

  socket.on('admin_delete_player', ({ requester, target }) => {
    if (!isAdmin(requester)) return;
    target = (typeof target === 'string') ? target.trim() : '';
    if (!target) return;
    state.players = state.players.filter(p => p !== target);
    delete state.predictions[target];
    // Remove from sweepstake assignments
    if (state.sweepstake.assignments) delete state.sweepstake.assignments[target];
    persistState();
    io.emit('state_update', state);
    console.log(`Admin deleted player: ${target}`);
  });

  socket.on('save_prediction', ({ player, matchId, side, value }) => {
    if (!player || !matchId || !['h', 'a'].includes(side)) return;
    if (typeof value !== 'number' || value < 0 || value > 99) return;
    if (!state.players.includes(player)) return;
    if (!state.predictions[player]) state.predictions[player] = {};
    if (!state.predictions[player][matchId]) state.predictions[player][matchId] = {};
    state.predictions[player][matchId][side] = value;
    persistState();
    // Only broadcast to other clients (sender already updated optimistically)
    socket.broadcast.emit('state_update', state);
  });

  socket.on('save_result', ({ matchId, h, a }) => {
    if (!matchId || typeof h !== 'number' || typeof a !== 'number') return;
    if (h < 0 || a < 0 || h > 99 || a > 99) return;
    state.results[matchId] = { h, a };
    delete state.live[matchId];
    persistState();
    io.emit('state_update', state);
  });

  socket.on('delete_result', ({ matchId }) => {
    delete state.results[matchId];
    persistState();
    io.emit('state_update', state);
  });

  // ── Sweepstake ──────────────────────────────────────────────────────────────
  socket.on('draw_sweepstake', ({ requester } = {}) => {
    if (!isAdmin(requester)) return;
    if (state.players.length === 0) return;
    const teams = shuffle(ALL_TEAMS);
    const assignments = {};
    state.players.forEach(p => { assignments[p] = []; });
    let i = 0;
    // Deal 3 teams per player round-robin; any leftover teams are unassigned
    const teamsPerPlayer = 3;
    const totalToAssign = Math.min(teams.length, state.players.length * teamsPerPlayer);
    for (let t = 0; t < totalToAssign; t++) {
      const player = state.players[t % state.players.length];
      assignments[player].push(teams[t]);
    }
    state.sweepstake = { drawn: true, assignments, eliminated: [] };
    persistState();
    io.emit('state_update', state);
    console.log(`Sweepstake drawn — ${state.players.length} players, ${totalToAssign} teams assigned`);
  });

  socket.on('reset_sweepstake', ({ requester } = {}) => {
    if (!isAdmin(requester)) return;
    state.sweepstake = { drawn: false, assignments: {}, eliminated: [] };
    persistState();
    io.emit('state_update', state);
  });

  socket.on('toggle_eliminated', ({ team }) => {
    if (typeof team !== 'string') return;
    const el = state.sweepstake.eliminated || [];
    const idx = el.indexOf(team);
    if (idx === -1) el.push(team);
    else el.splice(idx, 1);
    state.sweepstake.eliminated = el;
    persistState();
    io.emit('state_update', state);
  });

  socket.on('disconnect', () => {
    console.log(`- client ${socket.id}`);
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => res.json({
  ok: true,
  players: state.players.length,
  results: Object.keys(state.results).length,
  live: Object.keys(state.live).length,
  apiEnabled: !!API_KEY,
}));

// ── Start ─────────────────────────────────────────────────────────────────────
loadState();

// Set RESET_STATE=true on Railway to wipe players/predictions/sweepstake on next deploy
if (process.env.RESET_STATE === 'true') {
  console.log('⚠️  RESET_STATE=true — clearing all players, predictions and sweepstake');
  state.players     = [];
  state.predictions = {};
  state.sweepstake  = { drawn: false, assignments: {}, eliminated: [] };
  persistState();
}

if (API_KEY) {
  console.log('🔑 FOOTBALL_API_KEY set — live & final scores will auto-update');
  fetchScores();                              // immediate poll on startup
  setInterval(fetchScores, 2 * 60 * 1000);  // then every 2 minutes
} else {
  console.log('ℹ️  No FOOTBALL_API_KEY — results must be entered manually');
  console.log('   Get a free key at https://www.football-data.org/client/register');
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚽  CarryOnLife World Cup 2026 Prediction League`);
  console.log(`   http://localhost:${PORT}\n`);
});
