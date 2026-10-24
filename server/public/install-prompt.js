/* Install prompt - drop-in for any of our web apps.
 * Usage: <script src="install-prompt.js" defer></script> (+ a manifest.webmanifest and icon).
 * Shows nothing when the page already runs as an installed app (home-screen icon).
 * Otherwise offers to install: one tap on Android/Chrome/Edge, short instructions on iPhone.
 * "Not now" hides it for 7 days. Text is Hebrew when <html lang="he">, English otherwise.
 * Self-contained, CSP-safe (no inline styles/scripts), no dependencies. */
(() => {
  'use strict';
  const KEY = 'install-prompt-dismissed:' + location.pathname;
  const standalone = matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  if (standalone) return;
  try { if (Date.now() - Number(localStorage.getItem(KEY) || 0) < 7 * 864e5) return; } catch { /* no storage */ }

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const mobile = ios || /Android/.test(ua);
  const he = (document.documentElement.lang || '').startsWith('he');
  const T = he ? {
    title: 'להוסיף למסך הבית?', sub: 'נפתח כמו אפליקציה, בלי שורת כתובת.', install: 'התקנה', later: 'לא עכשיו',
    ios: 'בספארי: ללחוץ על כפתור השיתוף ⬆︎ ואז "הוספה למסך הבית".', ok: 'הבנתי',
  } : {
    title: 'Add to your home screen?', sub: 'Opens like an app, without the address bar.', install: 'Install', later: 'Not now',
    ios: 'In Safari: tap Share ⬆︎, then "Add to Home Screen".', ok: 'Got it',
  };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  let deferred = null;
  let bar = null;

  function dismiss() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ }
    bar?.remove();
    bar = null;
  }

  function button(label, primary, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      minHeight: '40px', padding: '0 16px', borderRadius: '10px', font: 'inherit', fontWeight: '600', cursor: 'pointer',
      border: primary ? '0' : '1px solid rgba(128,128,128,.4)',
      background: primary ? '#d97757' : 'transparent', color: primary ? '#fff' : 'inherit',
    });
    b.addEventListener('click', onclick);
    return b;
  }

  function show(mode) {
    if (bar) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', T.title);
    bar.dir = he ? 'rtl' : 'ltr';
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    Object.assign(bar.style, {
      position: 'fixed', left: '12px', right: '12px', bottom: 'max(12px, env(safe-area-inset-bottom))', zIndex: '2147483000',
      maxWidth: '480px', margin: '0 auto', padding: '14px 16px', borderRadius: '16px',
      background: dark ? '#2a2926' : '#ffffff', color: dark ? '#f3f1ea' : '#22211f',
      border: '1px solid ' + (dark ? '#3d3b37' : '#e2ded5'), boxShadow: '0 10px 30px rgba(0,0,0,.35)',
      font: '15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
      display: 'grid', gap: '10px',
    });
    const title = document.createElement('strong');
    title.textContent = T.title;
    const sub = document.createElement('div');
    sub.textContent = mode === 'ios' ? T.ios : T.sub;
    sub.style.opacity = '.75';
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
    if (mode === 'ios') {
      row.append(button(T.ok, true, dismiss));
    } else {
      row.append(button(T.later, false, dismiss), button(T.install, true, async () => {
        const p = deferred;
        deferred = null;
        bar?.remove();
        bar = null;
        if (!p) return;
        p.prompt();
        const { outcome } = await p.userChoice.catch(() => ({}));
        if (outcome !== 'accepted') dismiss();
      }));
    }
    bar.append(title, sub, row);
    (document.body || document.documentElement).append(bar);
  }

  // Chrome / Edge / Samsung: the browser tells us when the app is installable (and not yet installed).
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    setTimeout(() => show('native'), 1500);
  });
  addEventListener('appinstalled', () => { bar?.remove(); bar = null; });

  // iPhone/iPad have no install event - show the manual steps (Safari only can add to home screen).
  if (ios && mobile) setTimeout(() => show('ios'), 2000);
})();
