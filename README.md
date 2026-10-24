# Claude Remote

Continue any Claude desktop session from your phone, even when you're away from the PC.

**Panel:** https://lawebs.co.il/rc/ (username and password are in `data/secrets.json`)

1. Open the panel on your phone. It reads the Claude sidebar from the PC.
2. Tap a session. The PC opens it in Claude desktop and turns on **Remote Control**.
3. Tap **Open in Claude**. The session opens in the Claude app or claude.ai/code on your phone.

Other buttons: refresh the list, see the PC screen, **Start Claude** when the app is closed, and **Turn off** to switch Remote Control off again.
Tip: in your phone's browser, use "Add to Home Screen" so the panel opens like an app.

## How it works

```
phone ──HTTPS──▶ lawebs.co.il/rc (server/server.mjs, pm2 "claude-rc", :3193)
                        ▲ long-poll (agent token)
PC: agent/agent.py ─────┘   drives Claude desktop via Windows UI Automation (agent/claude_ui.py)
```

- The PC can't be reached from outside, so the agent polls the server for jobs and reports the results back.
- The agent uses accessibility actions only, never the mouse or keyboard. It works with the window covered and doesn't take over your input.
- Cloud sessions (marked "Cloud" in Claude) already run in the cloud. The panel sends you to claude.ai/code for those.
- The agent stops the PC from going to sleep while it runs (`"keepAwake": false` in `agent/config.json` turns that off). The display can still turn off.

## Local use (no phone)

```
rc.cmd              list → choose a number → connect
rc.cmd list
rc.cmd connect 5
```

## Maintenance

| Task | Command |
|---|---|
| Deploy the server or panel | `powershell -File deploy.ps1` |
| New random password (signs everyone out) | `powershell -File deploy.ps1 -NewPassword` |
| Change the username | `powershell -File deploy.ps1 -Username NAME` |
| Install or update the agent (scheduled task "Claude Remote Agent", starts at logon, watchdog every 5 min) | `powershell -File agent\install.ps1` |
| Remove the agent | `powershell -File agent\install.ps1 -Uninstall` |
| Agent log | `agent\agent.log` |

On the server: code in `/opt/claude-rc/app`, data in `/var/lib/claude-rc` (runs as user `claude-rc`), nginx snippet in `/etc/nginx/snippets/claude-rc.conf`.
Logins are throttled to 5 failed attempts per IP every 15 minutes, and a login lasts 30 days.
