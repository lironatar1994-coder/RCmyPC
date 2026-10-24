'use strict';

const $ = (s) => document.querySelector(s);
const ACTIVE = new Set(['queued', 'running']);

let S = null;            // last /api/state
let focusJob = null;     // job shown in the hero card
let heroDismissed = null;
let shotJob = null;
let pollTimer = null;
let lastAutoList = 0;

// ---- api ----------------------------------------------------------------------
async function api(path, body) {
  const opts = body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(`api/${path}`, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'login') { showLogin(); throw new Error(data.error || 'Sign in required'); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

async function queue(type, args) {
  const { job, agentOnline } = await api('jobs', { type, args });
  upsertJob(job);
  if (!agentOnline && type !== 'list') toast("Your PC looks offline - it'll run this when it's back (within 90s).");
  schedule(150);
  return job;
}

function upsertJob(job) {
  if (!S) return;
  const i = S.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) S.jobs[i] = job; else S.jobs.unshift(job);
}

const jobById = (id) => S?.jobs.find((j) => j.id === id) || null;
const activeJob = (type) => S?.jobs.find((j) => j.type === type && ACTIVE.has(j.status)) || null;

// ---- screens --------------------------------------------------------------------
function showLogin() {
  stopPolling();
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  setTimeout(() => $('#login-user').focus(), 50);
}

function showApp() {
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  schedule(0);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await api('login', { username: $('#login-user').value, password: $('#login-pass').value });
    $('#login-pass').value = '';
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('#logout').addEventListener('click', async () => {
  await api('logout', {}).catch(() => {});
  S = null;
  showLogin();
});

// ---- polling ----------------------------------------------------------------------
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

function schedule(ms) {
  stopPolling();
  pollTimer = setTimeout(tick, ms);
}

async function tick() {
  if (document.hidden) return; // resumes on visibilitychange
  try {
    S = await api('state');
    render();
    autoRefreshList();
  } catch (e) {
    if ($('#app').hidden) return;
    $('#pc-text').textContent = 'No connection';
  }
  const busy = S && S.jobs.some((j) => ACTIVE.has(j.status));
  schedule(busy ? 1000 : 3000);
}

// Fresh list whenever the panel is opened (the agent reads it in under a second).
function autoRefreshList() {
  if (!S?.agent.online || activeJob('list')) return;
  const stale = !S.sessionsAt || S.now - S.sessionsAt > 30e3;
  if (stale && Date.now() - lastAutoList > 30e3) {
    lastAutoList = Date.now();
    queue('list').catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) schedule(0); });

// ---- render --------------------------------------------------------------------------
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(((S?.now || Date.now()) - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICON_CHECK = ['M5 12.5l4.5 4.5L19 7.5'];
const ICON_X = ['M6 6l12 12M18 6 6 18'];
const ICON_ARROW = ['M9 6l6 6-6 6'];
const ICON_OPEN = ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'];

function render() {
  if (!S) return;
  const a = S.agent;
  const chip = $('#pc-chip');
  chip.className = `chip ${a.online ? 'on' : 'off'}`;
  $('#pc-text').textContent = a.online ? 'PC online' : `PC offline · ${ago(a.lastSeen)}`;
  chip.title = a.host ? `${a.host} · agent ${a.version} · tap to refresh` : 'Tap to refresh';
  $('#offline').hidden = a.online;
  $('#offline-text').textContent = a.lastSeen
    ? `Last seen ${ago(a.lastSeen)}. The PC has to be on, signed in, and running the agent.`
    : 'The agent has never connected. Run agent\\install.ps1 on the PC.';
  $('#no-claude').hidden = !(a.online && a.claudeRunning === false);
  $('#no-claude button').disabled = Boolean(activeJob('launch'));

  const listBusy = Boolean(activeJob('list'));
  document.querySelector('[data-action="list"].icon-btn').classList.toggle('busy', listBusy);
  $('#updated').textContent = S.sessionsAt ? `Sessions as of ${ago(S.sessionsAt)}${listBusy ? ' · refreshing…' : ''}` : (listBusy ? 'Reading the Claude sidebar…' : '');

  renderHero();
  renderList();
  renderJobs();
  renderShot();
}

let heroKey = '';
function renderHero() {
  const hero = $('#hero');
  // Show the newest connect/disconnect/launch unless the user closed it.
  const latest = S.jobs.find((j) => ['connect', 'disconnect', 'launch'].includes(j.type));
  if (latest && (!focusJob || latest.createdAt > (jobById(focusJob)?.createdAt || 0))) focusJob = latest.id;
  const j = jobById(focusJob);
  if (!j || heroDismissed === j.id) { hero.hidden = true; heroKey = ''; return; }
  const key = JSON.stringify([j.id, j.status, j.updatedAt, S.agent.online]);
  if (key === heroKey && !hero.hidden) return;
  heroKey = key;
  hero.hidden = false;
  hero.className = 'hero';
  hero.replaceChildren();
  const title = j.args?.title;
  const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { heroDismissed = j.id; renderHero(); } }, icon(ICON_X));
  close.style.marginInlineStart = 'auto';
  close.style.width = close.style.height = '36px';

  if (ACTIVE.has(j.status)) {
    const what = j.type === 'launch' ? 'Starting Claude on the PC…'
      : j.type === 'disconnect' ? 'Turning Remote Control off…' : 'Connecting…';
    const sub = j.status === 'queued'
      ? (S.agent.online ? 'Sent to your PC…' : 'Waiting for your PC to come online…')
      : (j.type === 'connect' ? 'Opening the session on the PC and switching on Remote Control' : 'Working on it');
    hero.append(el('div', { class: 'hero-head' }, el('span', { class: 'spinner' }), el('div', {},
      el('div', { class: 'hero-title' }, what),
      title ? el('div', { class: 'hero-sub', dir: 'auto' }, title) : null,
      el('div', { class: 'hero-sub' }, sub))));
    return;
  }

  if (j.status === 'done') {
    hero.classList.add('ok');
    if (j.type === 'connect' && j.result?.cloud) {
      hero.append(
        el('div', { class: 'hero-head' }, el('span', { class: 'badge-ok' }, icon(ICON_CHECK)), el('div', {},
          el('div', { class: 'hero-title' }, 'Cloud session - already on your phone'),
          el('div', { class: 'hero-sub', dir: 'auto' }, title),
          el('div', { class: 'hero-sub' }, 'It runs in the cloud, so no Remote Control is needed. Find it in the Claude app under Code.')), close),
        el('div', { class: 'hero-actions' },
          el('a', { class: 'btn primary', href: 'https://claude.ai/code', target: '_blank', rel: 'noopener noreferrer' }, icon(ICON_OPEN), 'Open Claude Code')),
      );
    } else if (j.type === 'connect' && j.result?.link) {
      const link = j.result.link;
      hero.append(
        el('div', { class: 'hero-head' }, el('span', { class: 'badge-ok' }, icon(ICON_CHECK)), el('div', {},
          el('div', { class: 'hero-title' }, 'Remote Control is on'),
          el('div', { class: 'hero-sub', dir: 'auto' }, title)), close),
        el('div', { class: 'hero-actions' },
          el('a', { class: 'btn primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon(ICON_OPEN), 'Open in Claude'),
          el('button', { class: 'btn', type: 'button', onclick: () => copy(link) }, 'Copy link'),
          el('button', { class: 'btn', type: 'button', onclick: () => queue('disconnect', j.args).catch(fail) }, 'Turn off')),
      );
    } else {
      const msg = j.type === 'launch' ? 'Claude is open on the PC'
        : j.type === 'disconnect' ? 'Remote Control is off' : 'Done';
      hero.append(el('div', { class: 'hero-head' }, el('span', { class: 'badge-ok' }, icon(ICON_CHECK)), el('div', {},
        el('div', { class: 'hero-title' }, msg), title ? el('div', { class: 'hero-sub', dir: 'auto' }, title) : null), close));
    }
    return;
  }

  hero.classList.add('bad');
  hero.append(
    el('div', { class: 'hero-head' }, el('span', { class: 'badge-ok badge-bad' }, icon(ICON_X)), el('div', {},
      el('div', { class: 'hero-title' }, j.type === 'connect' ? "Couldn't connect" : 'That did not work'),
      title ? el('div', { class: 'hero-sub', dir: 'auto' }, title) : null,
      el('div', { class: 'hero-sub' }, j.error || 'Unknown error')), close),
    el('div', { class: 'hero-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => queue(j.type, j.args).catch(fail) }, 'Try again'),
      el('button', { class: 'btn', type: 'button', onclick: () => openShot() }, 'See PC screen')),
  );
}

function statusClass(s) {
  if (/running|working|responding/i.test(s)) return 'running';
  if (!s || /idle/i.test(s)) return '';
  return 'attn';
}

let listKey = '';
function renderList() {
  const list = $('#list');
  const q = $('#search').value.trim().toLowerCase();
  const items = S.sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
  const busy = S.jobs.find((j) => j.type === 'connect' && ACTIVE.has(j.status));
  // Rebuild only on change, so a tap never lands on a node that was just replaced.
  const minute = Math.floor((S.now || 0) / 60e3);
  const key = JSON.stringify([items, S.links, busy?.id, S.agent.online, minute]);
  if (key === listKey) return;
  listKey = key;
  const frag = document.createDocumentFragment();
  let section = null;
  for (const s of items) {
    if (s.section !== section) {
      section = s.section;
      frag.append(el('h2', { class: 'section-h' }, section || 'Sessions'));
    }
    const rc = S.links[s.title];
    const mine = busy && busy.args.title === s.title && busy.args.occurrence === s.occurrence;
    const meta = [];
    if (s.status && !/idle/i.test(s.status)) meta.push(el('span', {}, s.status));
    if (s.current) meta.push(el('span', {}, 'Open on PC'));
    if (rc?.cloud) meta.push(el('span', { class: 'rc' }, 'Cloud session'));
    else if (rc?.enabled) meta.push(el('span', { class: 'rc' }, `Remote on · ${ago(rc.at)}`));
    frag.append(el('button', {
      class: `row${s.current ? ' is-current' : ''}`, type: 'button', 'aria-busy': mine ? 'true' : null,
      'aria-label': `Connect ${s.title}`,
      onclick: () => connect(s),
    },
    el('span', { class: `st ${statusClass(s.status)}`, title: s.status }),
    el('span', { class: 'main' }, el('span', { class: 't' }, s.title), meta.length ? el('span', { class: 'meta' }, meta) : null),
    mine ? el('span', { class: 'spinner' }) : el('span', { class: 'go' }, 'Connect', icon(ICON_ARROW))));
  }
  list.replaceChildren(frag);
  const empty = $('#empty');
  if (!S.sessions.length) {
    empty.hidden = false;
    empty.textContent = S.sessionsAt && !activeJob('list')
      ? 'The PC found no sessions in the Claude sidebar. Tap 🖥 to see its screen.'
      : (S.agent.online ? 'Reading sessions from the PC…' : 'No sessions yet - waiting for the PC.');
  } else if (!items.length) {
    empty.hidden = false;
    empty.textContent = 'No session matches.';
  } else empty.hidden = true;
}

const LABEL = { list: 'Refresh list', connect: 'Connect', disconnect: 'Turn off', status: 'Status', screenshot: 'Screenshot', launch: 'Start Claude' };
const STATUS = { queued: 'waiting', running: 'running', done: 'done', error: 'failed', expired: 'expired' };

let jobsKey = '';
function renderJobs() {
  const key = JSON.stringify([S.jobs.map((j) => [j.id, j.status]), Math.floor((S.now || 0) / 10e3)]);
  if (key === jobsKey) return;
  jobsKey = key;
  $('#jobs').replaceChildren(...S.jobs.map((j) => el('li', {},
    el('span', { class: `s-${j.status}` }, STATUS[j.status] || j.status),
    el('span', {}, el('b', {}, LABEL[j.type] || j.type), j.args?.title ? el('span', { dir: 'auto' }, ` · ${j.args.title}`) : null,
      j.error ? ` - ${j.error}` : '', ` · ${ago(j.updatedAt)}`))));
}

// ---- actions ---------------------------------------------------------------------------
function connect(s) {
  heroDismissed = null;
  queue('connect', { title: s.title, occurrence: s.occurrence })
    .then((j) => { focusJob = j.id; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); })
    .catch(fail);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const action = b.dataset.action;
  if (action === 'screenshot') return openShot(true);
  heroDismissed = null;
  queue(action).then((j) => { if (action === 'launch') focusJob = j.id; render(); }).catch(fail);
});

$('#search').addEventListener('input', () => { listKey = ''; if (S) renderList(); });
$('#pc-chip').addEventListener('click', () => queue('list').catch(fail));

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { toast(text); }
}

// ---- screenshot -------------------------------------------------------------------------
async function openShot(fresh = true) {
  $('#shot').hidden = false;
  document.body.style.overflow = 'hidden';
  if (fresh) {
    $('#shot-time').textContent = 'Taking a screenshot…';
    try { shotJob = (await queue('screenshot')).id; } catch (e) { fail(e); }
  }
  renderShot();
}

let shownShotAt = 0;
function renderShot() {
  if ($('#shot').hidden || !S) return;
  const j = jobById(shotJob);
  if (j && ACTIVE.has(j.status)) { $('#shot-time').textContent = 'Taking a screenshot…'; return; }
  if (j && j.status !== 'done') { $('#shot-time').textContent = j.error || 'Screenshot failed'; return; }
  if (S.screenshotAt) {
    $('#shot-time').textContent = `Screen ${ago(S.screenshotAt)}`;
    if (S.screenshotAt !== shownShotAt) {
      shownShotAt = S.screenshotAt;
      $('#shot-img').src = `api/screenshot?t=${S.screenshotAt}`;
    }
  }
}

$('#shot-close').addEventListener('click', () => {
  $('#shot').hidden = true;
  document.body.style.overflow = '';
});

// ---- misc ----------------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function fail(e) { toast(e.message || String(e)); }

(async function boot() {
  try {
    await api('me');
    showApp();
  } catch {
    showLogin();
  }
})();
