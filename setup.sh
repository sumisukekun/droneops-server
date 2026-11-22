#!/usr/bin/env bash
# DRONE OPS ACADEMY 対戦サーバー 設置スクリプト（Ubuntu 24.04 / ConoHa VPS 用）
# 使い方（VPS上で root で実行）:
#   bash setup.sh 163-44-143-132.sslip.io  you@example.com
# 1つ目: ドメイン（IPをハイフン区切りにした sslip.io なら独自ドメイン不要）
# 2つ目: Let's Encrypt の通知用メールアドレス
set -euo pipefail
DOMAIN="${1:?ドメインを指定してください（例 163-44-143-132.sslip.io）}"
EMAIL="${2:?メールアドレスを指定してください}"
APP_DIR=/opt/droneops-server
PORT=8787

echo "== 1/6 パッケージ =="
apt-get update -y
apt-get install -y curl ca-certificates nginx certbot python3-certbot-nginx ufw
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== 2/6 アプリ配置 =="
id droneops >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin droneops
mkdir -p "$APP_DIR/data"
SRC="$(cd "$(dirname "$0")" && pwd)"; [ -f "$SRC/index.js" ] || SRC="$SRC/.."
cp "$SRC/index.js" "$SRC/package.json" "$APP_DIR/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$APP_DIR/"
cd "$APP_DIR" && npm install --omit=dev
chown -R droneops:droneops "$APP_DIR"

echo "== 3/6 systemd サービス =="
cat > /etc/systemd/system/droneops.service <<UNIT
[Unit]
Description=Drone Ops Academy battle server
After=network.target

[Service]
User=droneops
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$APP_DIR/data
ExecStart=/usr/bin/node $APP_DIR/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now droneops
sleep 1
curl -fsS "http://127.0.0.1:$PORT/health" && echo " ← サーバー起動OK"

echo "== 4/6 nginx（wss://$DOMAIN/droneops を中継）=="
cat > /etc/nginx/sites-available/droneops <<NGX
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
  listen 80;
  server_name $DOMAIN;
  location /droneops {
    proxy_pass http://127.0.0.1:$PORT/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_read_timeout 3600s;
  }
  location = /droneops/health { proxy_pass http://127.0.0.1:$PORT/health; }
}
NGX
ln -sf /etc/nginx/sites-available/droneops /etc/nginx/sites-enabled/droneops
nginx -t && systemctl reload nginx

echo "== 5/6 ファイアウォール =="
# 同じVPSの他のサービス（ESCAPE RUSH: TCP 8480 / UDP 24700-24719）を止めないよう、
# ufw が既に有効な場合だけルールを追加する（無効なら ConoHa のセキュリティグループに任せる）
if ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw allow 8480/tcp >/dev/null
  ufw allow 24700:24719/udp >/dev/null
  echo "ufw: 80/443 を許可しました"
else
  echo "ufw は無効のまま（ConoHa のセキュリティグループで TCP 80/443 を開けてください）"
fi

echo "== 6/6 HTTPS 証明書（Let's Encrypt）=="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo
echo "完了！ アプリの src/config.js に次を設定してください："
echo "  server: 'wss://$DOMAIN/droneops',"
echo "動作確認: curl https://$DOMAIN/droneops/health"
