#!/usr/bin/env bash
# 既存の Docker Caddy（ドレミ楽譜）に droneops.businessmaker.net を追加する
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
C=doremi_gakufu-caddy-1
DIR="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' $C)"
CMD="$(docker inspect -f '{{join .Config.Cmd " "}}' $C)"
GAKUFU="$(echo "$CMD" | sed -n 's/.*--from \([^ ]*\).*/\1/p')"
[ -n "$GAKUFU" ] || GAKUFU=gakufu.businessmaker.net
echo "== compose dir: $DIR / gakufu domain: $GAKUFU"
[ -f "$DIR/docker-compose.yml" ] || { echo "docker-compose.yml not found in $DIR"; exit 1; }
# nginx は使わない（ポート80/443は Docker の Caddy が使用中）
systemctl disable --now nginx 2>/dev/null || true
TS=$(date +%s)
[ -f "$DIR/Caddyfile" ] && cp "$DIR/Caddyfile" "$DIR/Caddyfile.bak.$TS"
[ -f "$DIR/docker-compose.override.yml" ] && cp "$DIR/docker-compose.override.yml" "$DIR/docker-compose.override.yml.bak.$TS"
sed "s/__GAKUFU__/$GAKUFU/" "$HERE/Caddyfile" > "$DIR/Caddyfile"
cp "$HERE/docker-compose.override.yml" "$DIR/docker-compose.override.yml"
cd "$DIR"
DOMAIN="$GAKUFU" docker compose up -d caddy
echo "== waiting for certificate (up to 90s)..."
for i in $(seq 1 30); do
  curl -fsS https://droneops.businessmaker.net/droneops/health >/dev/null 2>&1 && break
  sleep 3
done
curl -sS -o /dev/null -w "gakufu https: %{http_code}\n" "https://$GAKUFU/" || true
curl -sS https://droneops.businessmaker.net/droneops/health && echo "  <- DRONEOPS DONE"
