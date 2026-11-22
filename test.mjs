// サーバーの結合テスト：2クライアントで マッチング→状態中継→チャット(NG除去)→結果→レート→ランキング
import WebSocket from 'ws';
import { createServer, cleanText, elo } from './index.js';
process.env.DATA_DIR = './data-test';
const { server, wss } = createServer();
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
function client(id, name) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d); inbox.push(m); waiters.forEach((w) => w()); });
  const next = (t, timeout = 3000) => new Promise((res, rej) => {
    const check = () => { const i = inbox.findIndex((m) => m.t === t); if (i >= 0) { res(inbox.splice(i, 1)[0]); return true; } };
    if (check()) return;
    const w = () => check() && waiters.splice(waiters.indexOf(w), 1);
    waiters.push(w);
    setTimeout(() => rej(new Error('timeout ' + t)), timeout);
  });
  return { ws, next, send: (m) => ws.send(JSON.stringify(m)), open: new Promise((r) => ws.on('open', r)), id, name };
}
const A = client('aaaaaaaa-1', 'Alice'), B = client('bbbbbbbb-2', 'Bob');
await A.open; await B.open;
A.send({ t: 'hello', id: A.id, token: 'tokenAAAAAAAAAAAAAAAA', name: 'Alice' });
B.send({ t: 'hello', id: B.id, token: 'tokenBBBBBBBBBBBBBBBB', name: 'Bob https://spam.example' });
const wa = await A.next('welcome'), wb = await B.next('welcome');
ok(wa.rating === 1000 && wb.name === 'Bob', `welcome (B name cleaned: "${wb.name}")`);
// なりすまし防止
const C = client('aaaaaaaa-1', 'Evil'); await C.open;
C.send({ t: 'hello', id: 'aaaaaaaa-1', token: 'wrongwrongwrongwrong', name: 'Evil' });
ok((await C.next('error')).code === 'bad_token', 'token mismatch rejected');
// マッチング
A.send({ t: 'queue', mode: 'dog', drone: 'falcon' });
B.send({ t: 'queue', mode: 'dog', drone: 'viper5' });
const ma = await A.next('matched'), mb = await B.next('matched');
ok(ma.room === mb.room && ma.host !== mb.host && ma.seed === mb.seed && ma.opp.name === 'Bob' && mb.opp.drone === 'falcon', 'matched pair');
// 状態中継＋チャットのNG除去
A.send({ t: 'st', s: { p: [1, 2, 3], h: 4, c: { n: 1, k: 't', v: 'しね noob' } } });
const sb = await B.next('st');
ok(sb.s.p[1] === 2 && sb.s.h === 4 && sb.s.c.v === '** noob', `state relay + chat filter ("${sb.s.c.v}")`);
B.send({ t: 'st', s: { c: { n: 1, k: 's', v: 'gg' } } });
ok((await A.next('st')).s.c.v === 'gg', 'stamp relay');
// 結果（双方一致）→ Elo
A.send({ t: 'result', winner: 'me' });
B.send({ t: 'result', winner: 'opp' });
const ra = await A.next('rating'), rb = await B.next('rating');
ok(ra.rating === 1016 && rb.rating === 984 && ra.w === 1 && rb.l === 1, `elo ${ra.rating}/${rb.rating}`);
// ランキング
A.send({ t: 'score', board: 'race1', value: 95.2, asc: true });
B.send({ t: 'score', board: 'race1', value: 88.1, asc: true });
await A.next('scored'); await B.next('scored');
A.send({ t: 'score', board: 'race1', value: 99.9, asc: true }); // 悪化は無視
A.send({ t: 'board', board: 'race1' });
const bd = await A.next('board');
ok(bd.rows.length === 2 && bd.rows[0].n === 'Bob' && bd.rows[1].v === 95.2 && bd.myRank === 2, 'board order asc + keep best');
A.send({ t: 'board', board: 'pvp' });
const pv = await A.next('board');
ok(pv.rows[0].n === 'Alice' && pv.rows[0].v === 1016 && pv.myRank === 1, 'pvp board');
// 切断 → 相手に通知
A.send({ t: 'queue', mode: 'race', drone: 'viper5' }); B.send({ t: 'queue', mode: 'race', drone: 'viper5' });
await A.next('matched'); await B.next('matched');
B.ws.close();
ok((await A.next('opp_left')).reason, 'opponent disconnect notified');
ok(cleanText('call 090-1234-5678 now') === 'call *** now', 'phone masked');
ok(elo(1000, 1000, 1) === 1016, 'elo formula');
A.ws.close(); C.ws.close();
wss.close(); server.close();
import('node:fs').then((fs) => fs.rmSync('./data-test', { recursive: true, force: true }));
setTimeout(() => process.exit(fail ? 1 : 0), 200);
