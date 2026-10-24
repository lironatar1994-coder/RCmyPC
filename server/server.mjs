#!/usr/bin/env node
// Claude Remote — relay between the phone panel (https://lawebs.co.il/rc/) and the
// agent on the PC. The PC can't be reached from outside, so the agent long-polls
// this server for jobs and reports back; the panel queues jobs and reads results.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3193;
const BASE = process.env.RC_BASE ?? '/rc';
const DATA = process.env.RC_DATA || path.join(ROOT, '.data');
const PUBLIC = path.join(ROOT, 'public');

const SESSION_MS = 30 * 24 * 3600e3;
const AGENT_ONLINE_MS = 45e3;
const POLL_WAIT_MS = 25e3;
const QUEUED_TTL_MS = 90e3;
const RUNNING_TTL_MS = 150e3;
const JOB_TYPES = new Set(['list', 'connect', 'disconnect', 'status', 'screenshot', 'launch']);

// ---- secrets ----------------------------------------------------------------
// auth.json is written by deploy.ps1: { username, salt, hash, agentTokenSha256 }
const auth = JSON.parse(fs.readFileSync(path.join(DATA, 'auth.json'), 'utf8'));
const cookieKeyFile = path.join(DATA, 'cookie.key');
if (!fs.existsSync(cookieKeyFile)) fs.writeFileSync(cookieKeyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
// Keyed on the password hash too, so changing the password signs everyone out.
const cookieKey = crypto.createHash('sha256').update(fs.readFileSync(cookieKeyFile, 'utf8').trim() + auth.hash).digest();

const b64url = (b) => Buffer.from(b).toString('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));
}

function signSession(user) {
  const body = b64url(JSON.stringify({ u: user, exp: Date.now() + SESSION_MS, n: crypto.randomBytes(6).toString('hex') }));
  return `${body}.${b64url(crypto.createHmac('sha256', cookieKey).update(body).digest())}`;
}

function readSession(req) {
  const m = /(?:^|;\s*)rc=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', cookieKey).update(body).digest();
  if (!safeEqual(Buffer.from(sig, 'base64url'), want)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    return s.exp > Date.now() && s.u === auth.username ? s.u : null;
  } catch { return null; }
}

function sessionCookie(value, maxAgeSec) {
  return `rc=${value}; Path=${BASE || '/'}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

function agentAuthorized(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest();
  return safeEqual(got, Buffer.from(auth.agentTokenSha256, 'hex'));
}

// ---- login throttling ---------------------------------------------------------
const failures = new Map(); // ip -> { n, first }
let globalFails = { n: 0, first: Date.now() };
function loginBlocked(ip) {
  const now = Date.now();
  if (now - globalFails.first > 3600e3) globalFails = { n: 0, first: now };
  if (globalFails.n >= 40) return 900;
  const f = failures.get(ip);
  if (!f) return 0;
  if (now - f.first > 900e3) { failures.delete(ip); return 0; }
  return f.n >= 5 ? Math.ceil((f.first + 900e3 - now) / 1000) : 0;
}
function loginFailed(ip) {
  const f = failures.get(ip) || { n: 0, first: Date.now() };
  f.n += 1;
  failures.set(ip, f);
  globalFails.n += 1;
}

// ---- state --------------------------------------------------------------------
const state = {
  agent: { lastSeen: 0, host: '', version: '', claudeRunning: null },
  sessions: [],
  current: null,
  sessionsAt: 0,
  links: {}, // title -> { link, enabled, at }
  screenshot: null, // { buf, at }
};
const jobs = new Map(); // id -> job, insertion ordered
let waiter = null; // pending agent long-poll { res, timer }

const stateFile = path.join(DATA, 'state.json');
try {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  Object.assign(state, { sessions: saved.sessions || [], current: saved.current ?? null, sessionsAt: saved.sessionsAt || 0, links: saved.links || {} });
} catch { /* first run */ }
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { sessions, current, sessionsAt, links } = state;
    fs.writeFile(stateFile, JSON.stringify({ sessions, current, sessionsAt, links }), { mode: 0o600 }, () => {});
  }, 500);
}

function publicJob(j) {
  const { id, type, args, status, result, error, createdAt, updatedAt } = j;
  return { id, type, args, status, result, error, createdAt, updatedAt };
}

function sweepJobs() {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.status === 'queued' && now - j.createdAt > QUEUED_TTL_MS) finish(j, false, null, 'The PC did not pick this up - is it on and the agent running?', 'expired');
    else if (j.status === 'running' && now - j.updatedAt > RUNNING_TTL_MS) finish(j, false, null, 'The PC did not answer in time', 'error');
  }
  while (jobs.size > 60) jobs.delete(jobs.keys().next().value);
}

function finish(j, ok, result, error, status) {
  j.status = status || (ok ? 'done' : 'error');
  j.result = result ?? null;
  j.error = error ?? null;
  j.updatedAt = Date.now();
}

function nextQueued() {
  sweepJobs();
  for (const j of jobs.values()) if (j.status === 'queued') return j;
  return null;
}

function dispatchToWaiter() {
  if (!waiter) return;
  const j = nextQueued();
  if (!j) return;
  const { res, timer } = waiter;
  waiter = null;
  clearTimeout(timer);
  j.status = 'running';
  j.updatedAt = Date.now();
  send(res, 200, { jobs: [publicJob(j)] });
}

function enqueue(type, args) {
  sweepJobs();
  const key = JSON.stringify([type, args]);
  for (const j of jobs.values()) {
    if ((j.status === 'queued' || j.status === 'running') && j.key === key) return j;
  }
  const active = [...jobs.values()].filter((j) => j.status === 'queued').length;
  if (active >= 10) throw Object.assign(new Error('Too many pending actions'), { status: 429 });
  const now = Date.now();
  const j = { id: crypto.randomBytes(8).toString('hex'), key, type, args, status: 'queued', result: null, error: null, createdAt: now, updatedAt: now };
  jobs.set(j.id, j);
  dispatchToWaiter();
  return j;
}

function agentOnline() {
  return Date.now() - state.agent.lastSeen < AGENT_ONLINE_MS || Boolean(waiter);
}

// ---- http helpers ---------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 64 * 1024) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  return (local && req.headers['x-real-ip']) || ra;
}

// Browsers send Origin on POST; a mismatch means a cross-site request.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const STATIC = new Map();
for (const f of fs.readdirSync(PUBLIC)) {
  const ext = path.extname(f);
  if (MIME[ext]) STATIC.set(f, { buf: fs.readFileSync(path.join(PUBLIC, f)), type: MIME[ext] });
}
// Cache-bust the page's script and stylesheet with their content hashes.
{
  const page = STATIC.get('index.html');
  let html = page.buf.toString('utf8');
  for (const name of ['app.js', 'app.css']) {
    const v = crypto.createHash('sha256').update(STATIC.get(name).buf).digest('hex').slice(0, 10);
    html = html.replace(`"${name}"`, `"${name}?v=${v}"`);
  }
  page.buf = Buffer.from(html);
}

function serveStatic(res, name) {
  const f = STATIC.get(name);
  if (!f) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': f.type,
    'Content-Length': f.buf.length,
    'Cache-Control': name.endsWith('.html') || name === 'sw.js' || name === 'install-prompt.js' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(f.buf);
}

function publicState() {
  sweepJobs();
  return {
    agent: { online: agentOnline(), lastSeen: state.agent.lastSeen || null, host: state.agent.host, version: state.agent.version, claudeRunning: state.agent.claudeRunning },
    sessions: state.sessions,
    current: state.current,
    sessionsAt: state.sessionsAt || null,
    links: state.links,
    screenshotAt: state.screenshot?.at || null,
    jobs: [...jobs.values()].slice(-12).reverse().map(publicJob),
    now: Date.now(),
  };
}

function cleanSessions(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 500).map((s, i) => ({
    index: i,
    title: String(s.title ?? '').slice(0, 300),
    status: String(s.status ?? '').slice(0, 40),
    section: String(s.section ?? '').slice(0, 80),
    occurrence: Math.max(0, Math.min(50, Number(s.occurrence) || 0)),
    current: Boolean(s.current),
  }));
}

// ---- routes -----------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (BASE) {
    if (p === BASE) { res.writeHead(308, { Location: `${BASE}/` }); return res.end(); }
    if (!p.startsWith(`${BASE}/`)) return send(res, 404, { error: 'Not found' });
    p = p.slice(BASE.length);
  }

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    const name = p === '/' ? 'index.html' : p.slice(1);
    return serveStatic(res, name);
  }

  const route = `${req.method} ${p}`;

  if (route === 'GET /api/health') return send(res, 200, { ok: true });

  // ---- agent ----
  if (p.startsWith('/api/agent/')) {
    if (!agentAuthorized(req)) return send(res, 401, { error: 'Unauthorized' });
    state.agent.lastSeen = Date.now();

    if (route === 'GET /api/agent/poll') {
      state.agent.host = (url.searchParams.get('host') || '').slice(0, 80);
      state.agent.version = (url.searchParams.get('v') || '').slice(0, 20);
      const cr = url.searchParams.get('claude');
      state.agent.claudeRunning = cr === null ? null : cr === '1';
      const j = nextQueued();
      if (j) {
        j.status = 'running';
        j.updatedAt = Date.now();
        return send(res, 200, { jobs: [publicJob(j)] });
      }
      if (waiter) { clearTimeout(waiter.timer); send(waiter.res, 200, { jobs: [] }); }
      const w = { res, timer: setTimeout(() => { if (waiter === w) waiter = null; state.agent.lastSeen = Date.now(); send(res, 200, { jobs: [] }); }, POLL_WAIT_MS) };
      waiter = w;
      req.on('close', () => { if (waiter === w) { clearTimeout(w.timer); waiter = null; } });
      return;
    }

    if (route === 'POST /api/agent/report') {
      const b = await readJson(req, 512 * 1024);
      const sessions = cleanSessions(b.sessions);
      if (sessions) {
        state.sessions = sessions;
        state.current = typeof b.current === 'string' ? b.current.slice(0, 300) : null;
        state.sessionsAt = Date.now();
      }
      if (typeof b.claudeRunning === 'boolean') state.agent.claudeRunning = b.claudeRunning;
      const j = b.jobId ? jobs.get(String(b.jobId)) : null;
      if (j) {
        const result = b.result && typeof b.result === 'object' ? b.result : null;
        finish(j, Boolean(b.ok), result, b.ok ? null : String(b.error || 'Failed').slice(0, 500));
        if (result && typeof result.title === 'string' && (j.type === 'connect' || j.type === 'disconnect' || j.type === 'status')) {
          state.links[result.title.slice(0, 300)] = {
            link: typeof result.link === 'string' && /^https:\/\/claude\.ai\//.test(result.link) ? result.link : null,
            enabled: Boolean(result.enabled),
            cloud: Boolean(result.cloud),
            at: Date.now(),
          };
        }
      }
      saveState();
      return send(res, 200, { ok: true });
    }

    if (route === 'POST /api/agent/screenshot') {
      if (!/^image\/(jpeg|png)$/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected an image' });
      const buf = await readBody(req, 3 * 1024 * 1024);
      state.screenshot = { buf, type: req.headers['content-type'], at: Date.now() };
      const j = jobs.get(String(url.searchParams.get('job') || ''));
      if (j) finish(j, true, { at: state.screenshot.at, bytes: buf.length });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ---- panel ----
  if (route === 'POST /api/login') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Forbidden' });
    const ip = clientIp(req);
    const wait = loginBlocked(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });
    const b = await readJson(req, 4096);
    const user = String(b.username ?? '').trim();
    const pass = String(b.password ?? '');
    const key = await scrypt(pass.slice(0, 256), auth.salt);
    const userOk = safeEqual(crypto.createHash('sha256').update(user.toLowerCase()).digest(), crypto.createHash('sha256').update(auth.username.toLowerCase()).digest());
    if (!(safeEqual(key, Buffer.from(auth.hash, 'hex')) && userOk)) {
      loginFailed(ip);
      await new Promise((r) => setTimeout(r, 400));
      return send(res, 401, { error: 'Wrong username or password' });
    }
    failures.delete(ip);
    return send(res, 200, { user: auth.username }, { 'Set-Cookie': sessionCookie(signSession(auth.username), SESSION_MS / 1000) });
  }

  if (route === 'POST /api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = readSession(req);
  if (!user) return send(res, 401, { error: 'Sign in required' });
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Forbidden' });

  if (route === 'GET /api/me') return send(res, 200, { user });
  if (route === 'GET /api/state') return send(res, 200, publicState());

  if (route === 'POST /api/jobs') {
    const b = await readJson(req, 4096);
    const type = String(b.type || '');
    if (!JOB_TYPES.has(type)) return send(res, 400, { error: 'Unknown action' });
    let args = {};
    if (type === 'connect' || type === 'disconnect') {
      const title = String(b.args?.title ?? '').slice(0, 300);
      if (!title) return send(res, 400, { error: 'Pick a session' });
      args = { title, occurrence: Math.max(0, Math.min(50, Number(b.args?.occurrence) || 0)) };
    }
    const j = enqueue(type, args);
    return send(res, 200, { job: publicJob(j), agentOnline: agentOnline() });
  }

  const jm = /^GET \/api\/jobs\/([0-9a-f]{16})$/.exec(route);
  if (jm) {
    sweepJobs();
    const j = jobs.get(jm[1]);
    return j ? send(res, 200, { job: publicJob(j) }) : send(res, 404, { error: 'Not found' });
  }

  if (route === 'GET /api/screenshot') {
    if (!state.screenshot) return send(res, 404, { error: 'No screenshot yet' });
    return send(res, 200, state.screenshot.buf, { 'Content-Type': state.screenshot.type });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Server error' : e.message });
  });
});
server.requestTimeout = 60e3;
server.headersTimeout = 30e3;
server.listen(PORT, '127.0.0.1', () => console.log(`Claude Remote on http://127.0.0.1:${PORT}${BASE}/`));
setInterval(sweepJobs, 10e3).unref();
