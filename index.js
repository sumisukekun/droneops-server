// ===== DRONE OPS ACADEMY 対戦サーバー =====
// 役割：マッチング（1対1）・対戦中の状態中継・チャット中継（NGワード除去）・ランキング・レート・通報記録
// 起動：node index.js  （環境変数 PORT=8787, DATA_DIR=./data）
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = +process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const MODES = ['race', 'dog', 'rush'];
const BOARD_RE = /^[a-z0-9_]{2,24}$/;
const MAX_ROWS = 500;
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 永続データ（JSON、原子的に書き込み） ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { players: {}, boards: {}, reports: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* 初回 */ }
let dirty = false;
function save() { dirty = true; }
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}, 3000).unref();

// ---------- ユーティリティ ----------
const NG = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'retard', 'kill yourself', 'kys',
  'しね', '死ね', 'ころす', '殺す', 'きもい', 'キモい', 'ばか', 'バカ', 'あほ', 'アホ', 'かす', 'カス', 'ちんこ', 'まんこ', 'セックス',
];
export function cleanText(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').trim().slice(0, 60);
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, '***'); // URL
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***'); // メール
  s = s.replace(/\d[\d\- ]{8,}\d/g, '***'); // 電話番号など
  const low = s.toLowerCase();
  for (const w of NG) {
    let i = low.indexOf(w);
    while (i >= 0) {
      s = s.slice(0, i) + '*'.repeat(w.length) + s.slice(i + w.length);
      i = low.indexOf(w, i + 1);
    }
  }
  return s;
}
export function cleanName(s) {
  const n = cleanText(s).replace(/\*/g, '').trim().slice(0, 16);
  return n || 'Pilot';
}
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Elo レート
export function elo(ra, rb, scoreA, k = 32) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(ra + k * (scoreA - ea));
}

function player(id) {
  return db.players[id];
}

// ---------- ランキング ----------
// board名、asc=trueなら小さいほど上位（タイム）
function submit(pl, board, value, asc) {
  if (!BOARD_RE.test(board) || typeof value !== 'number' || !isFinite(value) || value < 0 || value > 1e9) return false;
  const b = (db.boards[board] ||= { asc: !!asc, rows: {} });
  const cur = b.rows[pl.id];
  const better = !cur || (b.asc ? value < cur.v : value > cur.v);
  if (better) {
    b.rows[pl.id] = { v: value, n: pl.name, t: Date.now() };
    // 上限を超えたら下位を削る
    const ids = Object.keys(b.rows);
    if (ids.length > MAX_ROWS) {
      const sorted = ids.sort((x, y) => (b.asc ? b.rows[x].v - b.rows[y].v : b.rows[y].v - b.rows[x].v));
      for (const id of sorted.slice(MAX_ROWS)) delete b.rows[id];
    }
    save();
  }
  return better;
}
function top(board, meId, limit = 50) {
  if (board === 'pvp') {
    const rows = Object.values(db.players).filter((p) => p.w + p.l > 0)
      .sort((a, b) => b.rating - a.rating);
    const me = rows.findIndex((p) => p.id === meId);
    return { rows: rows.slice(0, limit).map((p) => ({ n: p.name, v: p.rating, w: p.w, l: p.l, me: p.id === meId })), myRank: me >= 0 ? me + 1 : null, total: rows.length, asc: false };
  }
  const b = db.boards[board];
  if (!b) return { rows: [], myRank: null, total: 0 };
  const ids = Object.keys(b.rows).sort((x, y) => (b.asc ? b.rows[x].v - b.rows[y].v : b.rows[y].v - b.rows[x].v));
  const me = ids.indexOf(meId);
  return { rows: ids.slice(0, limit).map((id) => ({ n: b.rows[id].n, v: b.rows[id].v, me: id === meId })), myRank: me >= 0 ? me + 1 : null, total: ids.length, asc: b.asc };
}

// ---------- 接続・マッチング ----------
const queues = { race: [], dog: [], rush: [] };
const rooms = new Map();
let seq = 0;

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function leaveQueue(ws) {
  for (const m of MODES) queues[m] = queues[m].filter((x) => x !== ws);
}

function leaveRoom(ws, reason = 'left') {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const other = room.a === ws ? room.b : room.a;
  if (other && other.room === room) {
    send(other, { t: 'opp_left', reason });
    // 途中離脱は相手の勝ち扱い（試合開始後のみ）
    if (!room.decided && Date.now() > room.startAt && ws.pl && other.pl) decide(room, other.pl.id, 'forfeit');
  }
  rooms.delete(room.id);
}

function decide(room, winnerId, why) {
  if (room.decided) return;
  room.decided = true;
  const A = room.a.pl, B = room.b.pl;
  if (!A || !B) return;
  const sa = winnerId === A.id ? 1 : winnerId === B.id ? 0 : 0.5;
  const ra = elo(A.rating, B.rating, sa), rb = elo(B.rating, A.rating, 1 - sa);
  A.rating = ra; B.rating = rb;
  if (sa === 1) { A.w++; B.l++; } else if (sa === 0) { B.w++; A.l++; } else { A.d = (A.d || 0) + 1; B.d = (B.d || 0) + 1; }
  save();
  for (const [ws, p] of [[room.a, A], [room.b, B]]) send(ws, { t: 'rating', rating: p.rating, w: p.w, l: p.l, why });
}

function tryMatch(mode) {
  const q = queues[mode];
  while (q.length >= 2) {
    const a = q.shift(), b = q.shift();
    if (a.readyState !== 1) { if (b.readyState === 1) q.unshift(b); continue; }
    if (b.readyState !== 1) { q.unshift(a); continue; }
    const room = { id: 'r' + (++seq) + '-' + Date.now().toString(36), mode, a, b, seed: Math.floor(Math.random() * 1e6), startAt: Date.now() + 4500, results: {} };
    rooms.set(room.id, room);
    a.room = b.room = room;
    const info = (ws) => ({ name: ws.pl.name, drone: ws.drone, rating: ws.pl.rating });
    send(a, { t: 'matched', room: room.id, mode, seed: room.seed, host: true, opp: info(b), startIn: 4500 });
    send(b, { t: 'matched', room: room.id, mode, seed: room.seed, host: false, opp: info(a), startIn: 4500 });
  }
}

export function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.bucket = 60; // レート制限（1秒あたり約40メッセージ）
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      ws.bucket = Math.min(80, ws.bucket);
      if (--ws.bucket < 0) return; // 超過分は捨てる
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      handle(ws, m);
    });
    ws.on('close', () => { leaveQueue(ws); leaveRoom(ws, 'disconnect'); });
  });

  // 生存確認・レート制限の補充
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      ws.bucket = Math.min(80, (ws.bucket || 0) + 40);
    }
  }, 1000);
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  wss.on('close', () => { clearInterval(iv); clearInterval(ping); });
  return { server, wss };
}

function handle(ws, m) {
  // 最初に hello（ID＋秘密トークンで本人確認）
  if (m.t === 'hello') {
    const id = String(m.id || '').slice(0, 40);
    const tok = String(m.token || '');
    if (!/^[a-z0-9-]{8,40}$/i.test(id) || tok.length < 16) return send(ws, { t: 'error', code: 'bad_hello' });
    let p = player(id);
    if (p && p.tok !== hash(tok)) return send(ws, { t: 'error', code: 'bad_token' });
    if (!p) p = db.players[id] = { id, tok: hash(tok), name: 'Pilot', rating: 1000, w: 0, l: 0, d: 0, created: Date.now() };
    p.name = cleanName(m.name);
    p.seen = Date.now();
    ws.pl = p;
    save();
    return send(ws, { t: 'welcome', id, name: p.name, rating: p.rating, w: p.w, l: p.l });
  }
  const p = ws.pl;
  if (!p) return;
  switch (m.t) {
    case 'name':
      p.name = cleanName(m.name);
      save();
      return send(ws, { t: 'name', name: p.name });
    case 'queue': {
      if (!MODES.includes(m.mode)) return;
      leaveQueue(ws);
      leaveRoom(ws);
      ws.drone = String(m.drone || 'viper5').slice(0, 16);
      queues[m.mode].push(ws);
      send(ws, { t: 'queued', mode: m.mode, waiting: queues[m.mode].length });
      return tryMatch(m.mode);
    }
    case 'cancel':
      leaveQueue(ws);
      return send(ws, { t: 'cancelled' });
    case 'st': {
      // 対戦中の自機状態 → 相手へ中継（チャットは除去して再構成）
      const room = ws.room;
      if (!room) return;
      const other = room.a === ws ? room.b : room.a;
      const s = m.s && typeof m.s === 'object' ? m.s : {};
      if (s.c && typeof s.c === 'object') {
        s.c = s.c.k === 't' ? { n: +s.c.n || 0, k: 't', v: cleanText(s.c.v) } : { n: +s.c.n || 0, k: 's', v: String(s.c.v).slice(0, 12) };
      }
      return send(other, { t: 'st', s });
    }
    case 'result': {
      // 双方の申告が一致したら確定。片方だけなら10秒後に申告を採用
      const room = ws.room;
      if (!room || room.decided) return;
      const winner = m.winner === 'me' ? p.id : m.winner === 'opp' ? (room.a === ws ? room.b.pl.id : room.a.pl.id) : 'draw';
      room.results[p.id] = winner;
      const vals = Object.values(room.results);
      if (vals.length === 2) decide(room, vals[0] === vals[1] ? vals[0] : 'draw', 'agreed');
      else setTimeout(() => { if (rooms.has(room.id) && !room.decided) decide(room, winner, 'single'); }, 10000);
      return;
    }
    case 'leave':
      return leaveRoom(ws);
    case 'score':
      if (submit(p, String(m.board), +m.value, !!m.asc)) send(ws, { t: 'scored', board: m.board });
      return;
    case 'board':
      return send(ws, { t: 'board', board: String(m.board), ...top(String(m.board), p.id) });
    case 'report':
      db.reports.push({ by: p.id, name: cleanName(m.name), text: cleanText(m.text), at: Date.now() });
      if (db.reports.length > 1000) db.reports.shift();
      save();
      return send(ws, { t: 'reported' });
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { server } = createServer();
  server.listen(PORT, () => console.log(`drone-ops server on :${PORT}`));
}
