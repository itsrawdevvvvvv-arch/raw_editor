#!/usr/bin/env bash
# One command to put the render server on any Linux box you can SSH into.
# Usage:  bash deploy.sh
# Needs: Ubuntu 22.04/24.04 (or Debian), root or sudo.
set -euo pipefail

PORT="${PORT:-7860}"
NAME="raw-edit-server"

echo "== installing docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi

echo "== opening port $PORT =="
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow "$PORT"/tcp || true
fi
# Ubuntu cloud images ship with an iptables rule that drops everything else
sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT 6 -p tcp --dport "$PORT" -j ACCEPT || true

echo "== building =="
cd "$(dirname "$0")"
sudo docker build -t raw-edit-server .

echo "== running =="
sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker run -d --restart always --name "$NAME" \
  -p "$PORT:$PORT" --memory=6g --cpus=3 raw-edit-server

echo "== waiting for it to answer =="
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "<this-machine-ip>")
    echo
    echo "READY"
    echo "Put this in the app under About > Server:  http://$IP:$PORT"
    exit 0
  fi
  sleep 2
done

echo "container started but /health did not answer. Check: sudo docker logs $NAME"
exit 1
