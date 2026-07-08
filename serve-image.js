#!/usr/bin/env node
'use strict';
// serve-image.js — zero-dependency file server for RPi fleet reflash.
//
// Put this next to the image AND reflash.sh, then run:
//     node serve-image.js ctrl-endpoint.img.xz
//     node serve-image.js ctrl-endpoint.img.xz --port 8080
//
// Serves files from the current directory (basename only — no path traversal),
// and serves /reflash.sh with IMG_URL auto-injected, so the per-Pi step is just:
//     curl -fsSL http://SERVER:PORT/reflash.sh | sudo bash

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- args ---
const args = process.argv.slice(2);
let port = 8080;
let image = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10);
  else if (!image) image = path.basename(args[i]);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${port}`);
  process.exit(1);
}

const ROOT = process.cwd();

if (image && !safeStat(image)) {
  console.error(`Image not found in ${ROOT}: ${image}`);
  process.exit(1);
}

// locate reflash.sh next to the cwd, falling back to next to this script
const SCRIPT_PATH = [
  path.join(ROOT, 'reflash.sh'),
  path.join(__dirname, 'reflash.sh'),
].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

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
function lanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k]) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// Build reflash.sh with IMG_URL injected, using the address the Pi actually used
// to reach us (Host header). Falls back to a detected LAN IP if the header is odd.
function buildReflashScript(hostHeader) {
  const raw = fs.readFileSync(SCRIPT_PATH, 'utf8');
  let host = (hostHeader || '').trim();
  if (!/^[A-Za-z0-9.\-:]+$/.test(host)) {
    host = `${lanIps()[0] || '127.0.0.1'}:${port}`;
  }
  const url = `http://${host}/${encodeURIComponent(image)}`;
  const inject = `IMG_URL="${url}"`;
  if (raw.startsWith('#!')) {
    const nl = raw.indexOf('\n');
    return raw.slice(0, nl + 1) + inject + '\n' + raw.slice(nl + 1);
  }
  return inject + '\n' + raw;
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
  res.on('finish', logLine);
  res.on('close', () => { if (!res.writableFinished) logLine(); });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    status = 405;
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed\n');
  }

  const pathname = decodeURIComponent((req.url || '').split('?')[0]);

  // --- /reflash.sh (and /reflash): dynamic, IMG_URL injected ---
  if (pathname === '/reflash.sh' || pathname === '/reflash') {
    if (!image) {
      status = 500; res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Server started without an image filename.\n');
    }
    if (!SCRIPT_PATH) {
      status = 500; res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('reflash.sh not found next to the server.\n');
    }
    let body;
    try { body = buildReflashScript(req.headers.host); }
    catch {
      status = 500; res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Could not build reflash script.\n');
    }
    const buf = Buffer.from(body, 'utf8');
    sent = req.method === 'HEAD' ? 0 : buf.length;
    res.writeHead(200, {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Length': buf.length,
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  // --- static file serving (the image) ---
  const name = pathname.replace(/^\/+/, '');
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
  const ips = lanIps();
  console.log(`\nServing ${ROOT}`);
  console.log(`Image:   ${image || '<none — pass a filename>'}`);
  console.log(`Script:  ${SCRIPT_PATH || '<reflash.sh not found — put it next to this server>'}`);
  console.log(`\nRun this on each Pi (as root):`);
  for (const h of (ips.length ? ips : ['127.0.0.1'])) {
    console.log(`  curl -fsSL http://${h}:${port}/reflash.sh | sudo bash`);
  }
  console.log(`\nKeep the Mac awake:  caffeinate -dimsu node serve-image.js ${image || '<image>'}`);
  console.log(`Ctrl-C to stop.\n`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  server.close(() => process.exit(0));
});
