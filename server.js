/*
 * KOHRA server - zero dependencies (Node 18+).
 *   node server.js [port]
 * Serves the web client, hosts rooms (authoritative engine) and speaks a
 * minimal RFC 6455 WebSocket so trainees on different machines can play together.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Kohra = require('./engine.js');

const PORT = +process.argv[2] || +process.env.PORT || 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/engine.js': 'engine.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const rooms = new Map();
function getRoom(code) {
  code = String(code || 'DEMO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'DEMO';
  if (!rooms.has(code)) {
    const room = Kohra.createRoom(code);
    room.timer = setInterval(function () { room.step(0.25); }, 250);
    rooms.set(code, room);
  }
  return rooms.get(code);
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const info = {};
    rooms.forEach(function (r, k) { info[k] = r.count(); });
    return res.end(JSON.stringify({ ok: true, name: 'kohra', rooms: info }));
  }
  if (url.pathname === '/api/aar' || url.pathname === '/api/aar.csv') {
    const room = rooms.get((url.searchParams.get('room') || 'DEMO').toUpperCase());
    if (!room) { res.writeHead(404); return res.end('No such room'); }
    const rep = room.eng.aar();
    if (url.pathname.endsWith('.csv')) {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="kohra-aar.csv"' });
      return res.end(aarCsv(rep));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rep, null, 2));
  }
  const file = STATIC[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, file), function (err, buf) {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

function csvCell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function aarCsv(rep) {
  const head = ['id', 't', 'role', 'order', 'rationale', 'note', 'transit_s', 'status', 'outcome', 'detail', 'score', 'label', 'confidence', 'freshest_report_age_s', 'belief_error', 'contradictory_reports'];
  const rows = rep.decisions.map(function (d) {
    const k = d.knowledge || {};
    return [d.id, d.t, d.role, d.text, d.rationale.tag, d.rationale.note, d.transit, d.status, d.outcome ? d.outcome.kind : '', d.outcome ? d.outcome.detail : '', d.score, d.label, k.confidence, k.freshestAge, k.beliefError, k.contradictory];
  });
  return [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\n');
}

// ---------------------------------------------------------------- WebSocket (RFC 6455, text frames)
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

server.on('upgrade', function (req, socket) {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const room = getRoom(url.searchParams.get('room'));
  const client = {
    id: crypto.randomBytes(6).toString('hex'), role: null, name: null,
    send: function (obj) { if (!socket.destroyed) socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); },
  };
  let buf = Buffer.alloc(0), msgParts = [], msgOp = 0;

  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1 << 20) { socket.destroy(); return; }
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) { socket.destroy(); return; }
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      let payload;
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        off += 4;
      } else payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 8) { socket.end(frame(8, Buffer.alloc(0))); return; }
      if (op === 9) { socket.write(frame(10, payload)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { msgOp = op; msgParts = [payload]; } else if (op === 0) msgParts.push(payload);
      if (fin) {
        const text = Buffer.concat(msgParts).toString('utf8'); msgParts = [];
        let m = null; try { m = JSON.parse(text); } catch (e) { /* ignore */ }
        if (m) room.handle(client, m);
      }
    }
  });
  const bye = function () { room.leave(client); };
  socket.on('close', bye);
  socket.on('error', bye);
});

server.listen(PORT, function () {
  console.log('KOHRA running on http://localhost:' + PORT + '  (room DEMO by default, use ?room=CODE)');
});
