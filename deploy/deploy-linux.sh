#!/usr/bin/env bash
# Activates an uploaded release of Claude Remote at https://lawebs.co.il/rc/
# Usage: deploy-linux.sh <release-id>   (files in /opt/claude-rc/incoming/)
set -Eeuo pipefail
release_id=${1:?release id required}
[[ "$release_id" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo 'bad release id' >&2; exit 1; }

base=/opt/claude-rc
incoming=$base/incoming
state=/var/lib/claude-rc            # auth.json, cookie key, last state; survives releases
config=/etc/nginx/sites-available/lawebs.co.il.conf
snippet=/etc/nginx/snippets/claude-rc.conf
port=3193
svc=claude-rc
site=https://lawebs.co.il/rc

exec 9>"$base.lock"
flock -w 300 9

test -f "$incoming/$release_id.tar.gz"
test -f "$incoming/auth.json"
test -f "$config"

id -u $svc >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin $svc

rm -rf "$base/app.next"
mkdir -p "$base/app.next"
tar -xzf "$incoming/$release_id.tar.gz" -C "$base/app.next"
test -f "$base/app.next/server.mjs"
test -f "$base/app.next/public/index.html"
chown -R root:root "$base/app.next"
chmod -R u=rwX,go=rX "$base/app.next"

install -d -m 700 -o $svc -g $svc "$state"
install -m 600 -o $svc -g $svc "$incoming/auth.json" "$state/auth.json"
rm -f "$incoming/auth.json"

rm -rf "$base/app.prev"
if test -d "$base/app"; then mv "$base/app" "$base/app.prev"; fi
mv "$base/app.next" "$base/app"

start_app() {
  pm2 delete $svc >/dev/null 2>&1 || true
  PORT=$port RC_DATA=$state RC_BASE=/rc pm2 start "$base/app/server.mjs" --name $svc --cwd "$base/app" \
    --uid $svc --gid $svc --time --max-memory-restart 150M >/dev/null
}
healthy() {
  for _ in $(seq 1 15); do
    curl -fsS --max-time 3 "http://127.0.0.1:$port/rc/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

start_app
if ! healthy; then
  echo "[ERR] new release did not start" >&2
  pm2 logs $svc --lines 30 --nostream >&2 || true
  if test -d "$base/app.prev"; then
    rm -rf "$base/app.failed"; mv "$base/app" "$base/app.failed"; mv "$base/app.prev" "$base/app"
    start_app; healthy && echo "Rolled back to the previous release" >&2
  fi
  exit 1
fi
pm2 save --force >/dev/null

# ---- nginx (idempotent) ----
backup=$(mktemp -d)
cp -a "$config" "$backup/site.conf"
if test -f "$snippet"; then cp -a "$snippet" "$backup/snippet.conf"; fi
restore_nginx() {
  cp -a "$backup/site.conf" "$config"
  if test -f "$backup/snippet.conf"; then cp -a "$backup/snippet.conf" "$snippet"; else rm -f "$snippet"; fi
  nginx -t && systemctl reload nginx || true
}
trap restore_nginx ERR

cat > "$snippet" <<NGINX
# Claude Remote panel - deployed from QQL/deploy.ps1
location = /rc { return 308 /rc/; }
location ^~ /rc/ {
    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 75s;
    client_max_body_size 4m;
}
NGINX

python3 - "$config" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
marker = '    include /etc/nginx/snippets/claude-rc.conf;'
if marker not in s:
    anchor = '    location / {'
    if s.count(anchor) != 1:
        raise SystemExit('Ambiguous nginx insertion point')
    p.write_text(s.replace(anchor, marker + '\n\n' + anchor, 1))
PY
nginx -t
systemctl reload nginx
sleep 1
curl -fsS --retry 4 --retry-all-errors --retry-delay 1 --max-time 10 "$site/api/health" >/dev/null
page=$(curl -fsS --max-time 10 "$site/")
[[ "$page" == *'Claude Remote'* ]]
trap - ERR
rm -rf "$backup" "$incoming/$release_id.tar.gz" "$base/app.failed"

echo "Live $site/ (release $release_id)"
