#!/usr/bin/env node
'use strict';
// serve-image.js — zero-dependency file server for RPi fleet reflash.
//
// Sit this next to your image and run:
//     node serve-image.js ctrl-endpoint-shrunk.img.xz
//     node serve-image.js ctrl-endpoint-shrunk.img.xz --port 8080
//
// Serves files from the current directory (basename only — no path traversal)
// and prints ready-to-paste URLs for the reflash script's IMG_URL.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- args ---
const args = process.argv.slice(2);
let port = 8080;
let highlight = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10);
  else if (!highlight) highlight = path.basename(args[i]);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${port}`);
  process.exit(1);
}

const ROOT = process.cwd();

if (highlight && !safeStat(highlight)) {
  console.error(`Not found in ${ROOT}: ${highlight}`);
  process.exit(1);
}

// --- helpers ---
function safeStat(name) {
  try {
    const s = fs.statSync(path.join(ROOT, name));
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}
function human(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)}${u[i]}`;
}
function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
}

// --- server ---
const server = http.createServer((req, res) => {
  const ip = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
  const t0 = Date.now();
  let status = 200;
  let sent = 0; // actual body bytes streamed (accurate even on aborted pulls)

  const logLine = () => console.log(
    `${ts()}  ${ip}  ${req.method} ${req.url}  ${status}  ` +
    `${human(sent)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  res.on('finish', logLine); // completed normally
  res.on('close', () => { if (!res.writableFinished) logLine(); }); // client aborted

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    status = 405;
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed\n');
  }

  // Resolve to a plain basename inside ROOT — reject subpaths / traversal / dotfiles.
  const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/+/, ''));
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    status = 400;
    res.writeHead(400);
    return res.end('Bad request\n');
  }

  const stat = safeStat(name);
  if (!stat) {
    status = 404;
    res.writeHead(404);
    return res.end('Not found\n');
  }

  const total = stat.size;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };

  // Range support so a flaky pull can be resumed instead of restarted.
  let start = 0, end = total - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        status = 416;
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
  }
  headers['Content-Length'] = end - start + 1;

  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(path.join(ROOT, name), { start, end });
  stream.on('data', (c) => { sent += c.length; });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

server.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });

server.listen(port, '0.0.0.0', () => {
  const ips = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k]) {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  }
  const f = highlight || '<your-image>';
  console.log(`\nServing ${ROOT}`);
  console.log(`\nReflash IMG_URL — paste one of these into the script:`);
  if (ips.length === 0) {
    console.log(`  http://127.0.0.1:${port}/${f}   (no LAN interface found)`);
  }
  for (const ip of ips) console.log(`  http://${ip}:${port}/${f}`);
  console.log(`\nCtrl-C to stop.\n`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  server.close(() => process.exit(0));
});
