// QWOP Party server: zero-dependency Node HTTP server.
// Rooms live in memory (snapshotted to DATA_DIR/rooms.json); clients get live
// state over Server-Sent Events and send actions with plain JSON POSTs.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC = path.join(__dirname, 'public');
const PLANCK = path.join(path.dirname(require.resolve('planck')), 'planck.min.js');

const COUNTDOWN_MS = 3000;   // 3-2-1 before the clock starts
const GRACE_MS = 1500;       // accept late score packets after the buzzer
const MAX_DISTANCE = 100;    // finish line
const ROOM_TTL_MS = 24 * 3600 * 1000;

/** @type {Map<string, any>} */
const rooms = new Map();
const streams = new Map(); // code -> Set<{res, playerId}>

// ---------- persistence ----------
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of data) rooms.set(r.code, r);
    console.log(`loaded ${rooms.size} room(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('could not load rooms:', e.message);
  }
  for (const r of rooms.values()) if (r.phase === 'running') scheduleFinish(r);
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify([...rooms.values()]));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) {
      console.error('could not save rooms:', e.message);
    }
  }, 1000);
}

// ---------- room logic ----------
const id = (n = 8) => crypto.randomBytes(n).toString('hex');
function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  while (rooms.has(code));
  return code;
}
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24);

function publicState(r) {
  const online = new Set([...(streams.get(r.code) || [])].map((s) => s.playerId));
  return {
    code: r.code,
    phase: r.phase,
    durationSec: r.durationSec,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    round: r.round,
    order: r.order,
    serverNow: Date.now(),
    players: Object.values(r.players).map((p) => ({
      id: p.id, name: p.name, best: p.best, cur: p.cur, attempts: p.attempts,
      admin: p.admin, online: online.has(p.id), joinedAt: p.joinedAt,
    })),
  };
}

const dirty = new Set();
function touch(r) {
  r.updatedAt = Date.now();
  dirty.add(r.code);
  save();
}
// Batch broadcasts so a dozen players streaming distances doesn't flood anyone.
setInterval(() => {
  for (const code of dirty) {
    const r = rooms.get(code);
    if (r) broadcast(r);
  }
  dirty.clear();
}, 200);

function broadcast(r) {
  const set = streams.get(r.code);
  if (!set) return;
  const msg = `data: ${JSON.stringify(publicState(r))}\n\n`;
  for (const s of set) s.res.write(msg);
}

const finishTimers = new Map();
function scheduleFinish(r) {
  clearTimeout(finishTimers.get(r.code));
  const ms = Math.max(0, r.endsAt + GRACE_MS - Date.now());
  finishTimers.set(r.code, setTimeout(() => finish(r), ms));
}
function finish(r) {
  clearTimeout(finishTimers.get(r.code));
  if (r.phase !== 'running') return;
  r.phase = 'finished';
  r.endsAt = Math.min(r.endsAt, Date.now());
  // Presentation order: shortest distance first, longest last. Ties are random.
  const list = Object.values(r.players).map((p) => ({ id: p.id, score: p.best ?? 0, tie: Math.random() }));
  list.sort((a, b) => a.score - b.score || a.tie - b.tie);
  r.order = list.map((p) => p.id);
  for (const p of Object.values(r.players)) p.cur = null;
  touch(r);
  console.log(`room ${r.code}: round ${r.round} finished`);
}

function resetScores(r) {
  for (const p of Object.values(r.players)) {
    p.best = null; p.cur = null; p.attempts = 0;
  }
  r.order = null;
}

// ---------- HTTP ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route('POST', /^\/api\/rooms$/, async (req, res) => {
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (!name) return send(res, 400, { error: 'Name required' });
  const code = newCode();
  const adminToken = id(12);
  const pid = id();
  const r = {
    code, adminToken, phase: 'lobby', durationSec: 300, startsAt: null, endsAt: null,
    round: 0, order: null, createdAt: Date.now(), updatedAt: Date.now(),
    players: { [pid]: { id: pid, name, best: null, cur: null, attempts: 0, admin: true, joinedAt: Date.now() } },
  };
  rooms.set(code, r);
  touch(r);
  console.log(`room ${code} created by ${name}`);
  send(res, 200, { code, adminToken, playerId: pid });
});

route('GET', /^\/api\/rooms\/([A-Z]{4})$/, (req, res, code) => {
  const r = rooms.get(code);
  if (!r) return send(res, 404, { error: 'Room not found' });
  send(res, 200, publicState(r));
});

route('POST', /^\/api\/rooms\/([A-Z]{4})\/join$/, async (req, res, code) => {
  const r = rooms.get(code);
  if (!r) return send(res, 404, { error: 'Room not found' });
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (!name) return send(res, 400, { error: 'Name required' });
  const isAdmin = body.adminToken === r.adminToken;
  // Re-joining with a known id (e.g. after a reload or rename) keeps your score.
  let p = body.playerId && r.players[body.playerId];
  if (p) {
    p.name = name;
  } else {
    const pid = id();
    p = r.players[pid] = { id: pid, name, best: null, cur: null, attempts: 0, admin: isAdmin, joinedAt: Date.now() };
  }
  if (isAdmin) p.admin = true;
  touch(r);
  send(res, 200, { playerId: p.id });
});

route('GET', /^\/api\/rooms\/([A-Z]{4})\/events$/, (req, res, code, url) => {
  const r = rooms.get(code);
  if (!r) return send(res, 404, { error: 'Room not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const s = { res, playerId: url.searchParams.get('playerId') };
  if (!streams.has(code)) streams.set(code, new Set());
  streams.get(code).add(s);
  res.write(`data: ${JSON.stringify(publicState(r))}\n\n`);
  touch(r); // presence changed
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(code)?.delete(s);
    if (rooms.has(code)) touch(rooms.get(code));
  });
});

route('POST', /^\/api\/rooms\/([A-Z]{4})\/score$/, async (req, res, code) => {
  const r = rooms.get(code);
  if (!r) return send(res, 404, { error: 'Room not found' });
  const body = await readJson(req);
  const p = r.players[body.playerId];
  if (!p) return send(res, 404, { error: 'Player not in room' });
  const now = Date.now();
  if (r.phase !== 'running' || now < r.startsAt || now > r.endsAt + GRACE_MS || body.round !== r.round) {
    return send(res, 409, { error: 'Round not running' });
  }
  const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(MAX_DISTANCE, n)) : null);
  const best = clamp(body.best);
  if (best != null && (p.best == null || best > p.best)) p.best = Math.round(best * 100) / 100;
  p.cur = body.fallen ? null : clamp(body.cur);
  if (Number.isInteger(body.attempts) && body.attempts > p.attempts) p.attempts = body.attempts;
  touch(r);
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/rooms\/([A-Z]{4})\/admin$/, async (req, res, code) => {
  const r = rooms.get(code);
  if (!r) return send(res, 404, { error: 'Room not found' });
  const body = await readJson(req);
  if (body.token !== r.adminToken) return send(res, 403, { error: 'Not the admin' });
  switch (body.action) {
    case 'start': {
      const d = Math.round(Number(body.durationSec));
      if (d >= 10 && d <= 3600) r.durationSec = d;
      resetScores(r);
      r.round += 1;
      r.phase = 'running';
      r.startsAt = Date.now() + COUNTDOWN_MS;
      r.endsAt = r.startsAt + r.durationSec * 1000;
      scheduleFinish(r);
      console.log(`room ${code}: round ${r.round} started (${r.durationSec}s)`);
      break;
    }
    case 'end':
      if (r.phase === 'running') {
        r.endsAt = Date.now();
        finish(r);
      }
      break;
    case 'reset':
      clearTimeout(finishTimers.get(code));
      resetScores(r);
      r.phase = 'lobby';
      r.startsAt = r.endsAt = null;
      break;
    case 'kick':
      delete r.players[body.playerId];
      if (r.order) r.order = r.order.filter((x) => x !== body.playerId);
      break;
    case 'duration': {
      const d = Math.round(Number(body.durationSec));
      if (d >= 10 && d <= 3600) r.durationSec = d;
      break;
    }
    default:
      return send(res, 400, { error: 'Unknown action' });
  }
  touch(r);
  send(res, 200, { ok: true });
});

route('GET', /^\/vendor\/planck\.min\.js$/, (req, res) => serveFile(res, PLANCK));
route('GET', /^\/(?:r\/[A-Za-z]{4}\/?)?$/, (req, res) => serveFile(res, path.join(PUBLIC, 'index.html')));
route('GET', /^\/([\w-]+\.(?:js|css|svg))$/, (req, res, file) => serveFile(res, path.join(PUBLIC, file)));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (m) {
      try {
        return await r.fn(req, res, ...m.slice(1), url);
      } catch (e) {
        console.error(e);
        return send(res, 500, { error: 'Server error' });
      }
    }
  }
  send(res, 404, 'not found');
});

// Drop rooms nobody has touched in a day.
setInterval(() => {
  for (const [code, r] of rooms) {
    if (Date.now() - r.updatedAt > ROOM_TTL_MS && !(streams.get(code)?.size)) rooms.delete(code);
  }
}, 3600 * 1000);

load();
server.listen(PORT, () => console.log(`QWOP Party listening on http://0.0.0.0:${PORT}`));
