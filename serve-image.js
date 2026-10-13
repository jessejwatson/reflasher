#!/usr/bin/env node
'use strict';
// serve-image.js — zero-dependency image server + admin UI for RPi fleet reflash.
//
// Run it in (or point it at) the directory that holds your images:
//     node serve-image.js
//     node serve-image.js --port 8080 --data /path/to/images
//
// Open http://SERVER:PORT/ to upload, archive and delete images, and to assign
// images to named scripts (e.g. "pi4", "pi3"). Each script is then run on a Pi:
//     curl -fsSL http://SERVER:PORT/reflash/pi4.sh | sudo bash
// /reflash.sh is kept as an alias for the script named "default".
//
// Data directory layout:
//     <data>/*.img.xz         active images (servable, assignable)
//     <data>/archive/*.img.xz archived images (kept, but not served)
//     <data>/scripts.json     { "pi4": "image-a.img.xz", "pi3": "image-b.img.xz" }
//
// Set REFLASHER_PASSWORD to require a password (entered in the UI's login form)
// for the admin API. Script and image downloads stay open so Pis can fetch them.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

// --- args ---
const args = process.argv.slice(2);
let port = 8080;
let dataDir = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10);
  else if (args[i] === '--data' || args[i] === '-d') dataDir = path.resolve(args[++i]);
  else {
    console.error(`Unknown argument: ${args[i]}`);
    console.error('Images are now managed in the web UI — start with no image argument.');
    process.exit(1);
  }
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${port}`);
  process.exit(1);
}

const ROOT = dataDir;
const ARCHIVE = path.join(ROOT, 'archive');
const SCRIPTS_FILE = path.join(ROOT, 'scripts.json');
const UI_DIR = path.join(__dirname, 'ui', 'dist');
const PASSWORD = process.env.REFLASHER_PASSWORD || '';
// Base URL Pis should use for scripts, shown in the admin UI. Needed when the
// UI is reached through a reverse proxy, since Pis must hit the server by IP.
const PUBLIC_URL = (process.env.REFLASHER_PUBLIC_URL || '').replace(/\/+$/, '');
if (PUBLIC_URL && !/^http:\/\/[A-Za-z0-9.\-:]+$/.test(PUBLIC_URL)) {
  console.error(`REFLASHER_PUBLIC_URL must look like http://10.0.0.5:8080 (got ${PUBLIC_URL})`);
  process.exit(1);
}

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.img\.xz$/;
const SCRIPT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// locate reflash.sh in the data dir, falling back to next to this script
const SCRIPT_PATH = [
  path.join(ROOT, 'reflash.sh'),
  path.join(__dirname, 'reflash.sh'),
].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

fs.mkdirSync(ARCHIVE, { recursive: true });

// --- helpers ---
function statFile(p) {
  try {
    const s = fs.statSync(p);
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

// --- scripts.json: script name -> image filename ---
function loadScripts() {
  try {
    const obj = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}
async function saveScripts(scripts) {
  const tmp = `${SCRIPTS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(scripts, null, 2) + '\n');
  await fsp.rename(tmp, SCRIPTS_FILE); // atomic replace
}

async function listImages(dir, archived) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch {}
  const out = [];
  for (const name of names) {
    if (!IMAGE_RE.test(name)) continue;
    const s = statFile(path.join(dir, name));
    if (s) out.push({ name, size: s.size, modified: s.mtime.toISOString(), archived });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Build reflash.sh with IMG_URL injected, using the address the Pi actually used
// to reach us (Host header). Falls back to a detected LAN IP if the header is odd.
function buildReflashScript(hostHeader, image) {
  const raw = fs.readFileSync(SCRIPT_PATH, 'utf8');
  let host = (hostHeader || '').trim();
  if (!/^[A-Za-z0-9.\-:]+$/.test(host)) {
    host = `${lanIps()[0] || '127.0.0.1'}:${port}`;
  }
  const url = `http://${host}/images/${encodeURIComponent(image)}`;
  const inject = `IMG_URL="${url}"`;
  if (raw.startsWith('#!')) {
    const nl = raw.indexOf('\n');
    return raw.slice(0, nl + 1) + inject + '\n' + raw.slice(nl + 1);
  }
  return inject + '\n' + raw;
}

// Path prefix a reverse proxy stripped before forwarding (Traefik's stripprefix
// sets X-Forwarded-Prefix), so the UI can resolve its assets and API under it.
function forwardedPrefix(req) {
  const p = String(req.headers['x-forwarded-prefix'] || '').replace(/\/+$/, '');
  return /^(\/[A-Za-z0-9._~-]+)*$/.test(p) ? p : '';
}

// Where Pis should fetch scripts from. Behind a proxy the browser's address is
// the proxy's hostname, which the Pi can't use (see reflash.sh), so require
// REFLASHER_PUBLIC_URL there; when reached directly, the Host header is fine.
function scriptBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proxied = req.headers['x-forwarded-host'] || req.headers['x-forwarded-prefix'];
  const host = String(req.headers.host || '');
  return !proxied && /^[A-Za-z0-9.\-:]+$/.test(host) ? `http://${host}` : null;
}

// --- login sessions ---
// A session cookie holds "<expiry>.<hmac>", signed with a key derived from the
// password, so sessions survive restarts and changing the password ends them.
const SESSION_COOKIE = 'reflasher_session';
const SESSION_TTL = 7 * 24 * 60 * 60; // seconds
const SESSION_KEY = crypto.createHash('sha256').update(`reflasher-session\0${PASSWORD}`).digest();

const sign = (expiry) => crypto.createHmac('sha256', SESSION_KEY).update(String(expiry)).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=${forwardedPrefix(req)}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function authorized(req) {
  if (!PASSWORD) return true;
  const [expiry, mac] = readCookie(req, SESSION_COOKIE).split('.');
  return Number(expiry) > Date.now() / 1000 && !!mac && safeEqual(mac, sign(expiry));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// --- admin API ---
async function handleApi(req, res, pathname) {
  const send = (status, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
    res.end(buf);
    return status;
  };
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const [resource, name, action] = parts;

  // POST /api/login { password }
  if (resource === 'login' && req.method === 'POST' && !name) {
    const { password } = await readJson(req);
    if (!PASSWORD) throw new HttpError(400, 'No password is set on this server');
    if (typeof password !== 'string' || !safeEqual(password, PASSWORD)) {
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      throw new HttpError(401, 'Wrong password');
    }
    const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL;
    res.setHeader('Set-Cookie', sessionCookie(req, `${expiry}.${sign(expiry)}`, SESSION_TTL));
    return send(200, { ok: true });
  }

  // POST /api/logout
  if (resource === 'logout' && req.method === 'POST' && !name) {
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return send(200, { ok: true });
  }

  if (!authorized(req)) throw new HttpError(401, 'Login required');

  // GET /api/state
  if (resource === 'state' && req.method === 'GET' && !name) {
    const scripts = loadScripts();
    return send(200, {
      images: [...await listImages(ROOT, false), ...await listImages(ARCHIVE, true)],
      scripts: Object.keys(scripts).sort().map((n) => ({ name: n, image: scripts[n] })),
      scriptBase: scriptBase(req),
      authRequired: !!PASSWORD,
    });
  }

  if (resource === 'images' && name) {
    if (!IMAGE_RE.test(name)) throw new HttpError(400, 'Image names must look like name.img.xz (letters, digits, . _ -)');
    const active = path.join(ROOT, name);
    const archived = path.join(ARCHIVE, name);
    const usedBy = () => Object.entries(loadScripts()).filter(([, img]) => img === name).map(([s]) => s);

    // PUT /api/images/:name — raw request body is the file
    if (req.method === 'PUT' && !action) {
      if (statFile(active) || statFile(archived)) throw new HttpError(409, `${name} already exists`);
      const tmp = path.join(ROOT, `.upload-${crypto.randomBytes(6).toString('hex')}`);
      try {
        await pipeline(req, fs.createWriteStream(tmp));
        if (statFile(active)) throw new HttpError(409, `${name} already exists`);
        await fsp.rename(tmp, active);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      return send(201, { ok: true });
    }

    // POST /api/images/:name/archive | /unarchive
    if (req.method === 'POST' && (action === 'archive' || action === 'unarchive')) {
      const [from, to] = action === 'archive' ? [active, archived] : [archived, active];
      if (!statFile(from)) throw new HttpError(404, `${name} not found`);
      if (statFile(to)) throw new HttpError(409, `${name} already exists in the destination`);
      if (action === 'archive') {
        const used = usedBy();
        if (used.length) throw new HttpError(409, `${name} is assigned to: ${used.join(', ')}`);
      }
      await fsp.rename(from, to);
      return send(200, { ok: true });
    }

    // DELETE /api/images/:name
    if (req.method === 'DELETE' && !action) {
      const used = usedBy();
      if (used.length) throw new HttpError(409, `${name} is assigned to: ${used.join(', ')}`);
      const target = statFile(active) ? active : statFile(archived) ? archived : null;
      if (!target) throw new HttpError(404, `${name} not found`);
      await fsp.unlink(target);
      return send(200, { ok: true });
    }
  }

  if (resource === 'scripts' && name && !action) {
    if (!SCRIPT_RE.test(name)) throw new HttpError(400, 'Script names: lowercase letters, digits, - and _');

    // PUT /api/scripts/:name  { image }
    if (req.method === 'PUT') {
      const { image } = await readJson(req);
      if (typeof image !== 'string' || !IMAGE_RE.test(image) || !statFile(path.join(ROOT, image))) {
        throw new HttpError(400, 'Pick an active (non-archived) image');
      }
      const scripts = loadScripts();
      scripts[name] = image;
      await saveScripts(scripts);
      return send(200, { ok: true });
    }

    // DELETE /api/scripts/:name
    if (req.method === 'DELETE') {
      const scripts = loadScripts();
      if (!(name in scripts)) throw new HttpError(404, `Script ${name} not found`);
      delete scripts[name];
      await saveScripts(scripts);
      return send(200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

// --- file serving with Range support ---
function serveFile(req, res, filePath, contentType, setStatus, addSent) {
  const stat = statFile(filePath);
  if (!stat) return false;
  const total = stat.size;
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };

  // Range support so a flaky pull can be resumed instead of restarted.
  let status = 200;
  let start = 0, end = total - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        setStatus(416);
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return true;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
  }
  headers['Content-Length'] = end - start + 1;

  setStatus(status);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return true; }

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('data', (c) => addSent(c.length));
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return true;
}

// --- server ---
const server = http.createServer(async (req, res) => {
  const ip = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
  const t0 = Date.now();
  let status = 200;
  let sent = 0; // actual body bytes streamed (accurate even on aborted pulls)
  const setStatus = (s) => { status = s; };
  const addSent = (n) => { sent += n; };

  const logLine = () => console.log(
    `${ts()}  ${ip}  ${req.method} ${req.url}  ${status}  ` +
    `${human(sent)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  res.on('finish', logLine);
  res.on('close', () => { if (!res.writableFinished) logLine(); });

  const text = (s, body, extra = {}) => {
    status = s;
    res.writeHead(s, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
    res.end(body);
  };

  let pathname;
  try { pathname = decodeURIComponent((req.url || '').split('?')[0]); }
  catch { return text(400, 'Bad request\n'); }
  if (pathname.includes('\0') || pathname.split('/').some((seg) => seg === '..')) {
    return text(400, 'Bad request\n');
  }

  // --- admin API (auth checked in handleApi, after login/logout) ---
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      status = await handleApi(req, res, pathname);
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error(err);
      if (!res.headersSent) {
        const buf = Buffer.from(JSON.stringify({ error: err.message || 'Server error' }));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, Connection: 'close' });
        res.end(buf);
      } else {
        res.destroy();
      }
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text(405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
  }

  // --- /reflash/<name>.sh (and /reflash.sh -> "default"): IMG_URL injected ---
  const sm = /^\/reflash(?:\/([^/]+?))?(?:\.sh)?$/.exec(pathname);
  if (sm) {
    const scriptName = sm[1] || 'default';
    const scripts = loadScripts();
    const image = SCRIPT_RE.test(scriptName) && Object.hasOwn(scripts, scriptName) ? scripts[scriptName] : null;
    if (typeof image !== 'string') return text(404, `No script named "${scriptName}" — assign one in the web UI.\n`);
    if (!IMAGE_RE.test(image) || !statFile(path.join(ROOT, image))) return text(500, `Image for "${scriptName}" is missing: ${image}\n`);
    if (!SCRIPT_PATH) return text(500, 'reflash.sh not found next to the server.\n');
    let body;
    try { body = buildReflashScript(req.headers.host, image); }
    catch { return text(500, 'Could not build reflash script.\n'); }
    const buf = Buffer.from(body, 'utf8');
    sent = req.method === 'HEAD' ? 0 : buf.length;
    res.writeHead(200, {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Length': buf.length,
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  // --- /images/<name>: active images only ---
  if (pathname.startsWith('/images/')) {
    const name = pathname.slice('/images/'.length);
    if (!IMAGE_RE.test(name)) return text(400, 'Bad request\n');
    if (!serveFile(req, res, path.join(ROOT, name), 'application/octet-stream', setStatus, addSent)) {
      return text(404, 'Not found\n');
    }
    return;
  }

  // --- admin UI (static; it shows a login form when the API says 401) ---
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep)) return text(400, 'Bad request\n');
  // index.html gets a <base> for the proxy prefix, so relative asset and API
  // URLs resolve whether or not the browser's URL ends in a slash.
  if (rel === 'index.html' && statFile(file)) {
    const html = fs.readFileSync(file, 'utf8')
      .replace('<head>', `<head>\n    <base href="${forwardedPrefix(req)}/" />`);
    const buf = Buffer.from(html, 'utf8');
    sent = req.method === 'HEAD' ? 0 : buf.length;
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  if (serveFile(req, res, file, type, setStatus, addSent)) return;
  if (pathname === '/') return text(500, 'UI not built — run `npm install && npm run build` in ui/.\n');
  return text(404, 'Not found\n');
});

server.requestTimeout = 0; // multi-GB uploads can take a while
server.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });

server.listen(port, '0.0.0.0', () => {
  const ips = lanIps();
  const scripts = loadScripts();
  console.log(`\nData:    ${ROOT}`);
  console.log(`Script:  ${SCRIPT_PATH || '<reflash.sh not found — put it next to this server>'}`);
  console.log(`Pi URL:  ${PUBLIC_URL || '<from browser address — set REFLASHER_PUBLIC_URL when behind a proxy>'}`);
  console.log(`Auth:    ${PASSWORD ? 'password login on admin UI' : 'NONE — set REFLASHER_PASSWORD to protect the admin UI'}`);
  console.log(`\nAdmin UI:`);
  for (const h of (ips.length ? ips : ['127.0.0.1'])) console.log(`  http://${h}:${port}/`);
  const names = Object.keys(scripts).sort();
  console.log(`\nScripts: ${names.length ? '' : '<none yet — assign one in the admin UI>'}`);
  for (const n of names) {
    console.log(`  ${n.padEnd(12)} -> ${scripts[n]}`);
    console.log(`    curl -fsSL http://${ips[0] || '127.0.0.1'}:${port}/reflash/${n}.sh | sudo bash`);
  }
  console.log(`\nKeep the Mac awake:  caffeinate -dimsu node serve-image.js`);
  console.log(`Ctrl-C to stop.\n`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
