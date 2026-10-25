# Claude Remote (moved)

This project now lives inside **Server Monitor** and is no longer deployed from here.

- **Screen:** https://monitor.vee-app.co.il/serve-monitor/remote (`מחשב`, owner-only, behind the monitor's password and code sign-in). The old `https://lawebs.co.il/rc/` redirects there.
- **Relay:** `backend/remoteControl.js` and `backend/routes/remote.js` in the ServerMonitor repository. The standalone `claude-rc` process was retired on 2026-10-25.
- **PC agent:** `pc-agent/` in the ServerMonitor repository. Install or update it on a PC with `pc-agent\install.cmd`. It also runs Server Monitor's outside availability checks and warns on the PC when the monitor stops answering.

Agents installed from this repository keep working through `lawebs.co.il/rc/api/agent/` until they are reinstalled from `pc-agent/`.
