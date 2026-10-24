// Creates/keeps the local secrets and derives what the server and the agent need.
//   data/secrets.json  - username, password, agent token (local only, never uploaded)
//   dist/auth.json     - username + scrypt hash + sha256(agent token)  -> server
//   agent/config.json  - server URL + agent token                      -> agent
// Flags: --new-password  --username <name>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'secrets.json');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function newPassword() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += abc[crypto.randomInt(abc.length)];
    groups.push(s);
  }
  return groups.join('-');
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
let created = false;
if (opt('--username')) s.username = opt('--username');
s.username ||= 'liron';
if (!s.password || flag('--new-password')) { s.password = newPassword(); created = true; }
s.salt ||= crypto.randomBytes(16).toString('hex');
s.agentToken ||= crypto.randomBytes(32).toString('base64url');
s.server ||= 'https://lawebs.co.il/rc';
fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });

const hash = crypto.scryptSync(s.password, Buffer.from(s.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
const agentTokenSha256 = crypto.createHash('sha256').update(s.agentToken).digest('hex');
fs.writeFileSync(path.join(root, 'dist', 'auth.json'), JSON.stringify({ username: s.username, salt: s.salt, hash, agentTokenSha256 }));

const cfgFile = path.join(root, 'agent', 'config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : { keepAwake: true };
cfg.server = s.server;
cfg.token = s.agentToken;
fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });

console.log(`Login user: ${s.username}${created ? '  (new password written to data/secrets.json)' : ''}`);
