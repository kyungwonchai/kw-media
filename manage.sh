#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT=10150
PIDFILE="$DIR/.app.pid"
LOGFILE="$DIR/app.log"

is_running() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  if ss -tulpn 2>/dev/null | grep -q ":$PORT "; then
    return 0
  fi
  return 1
}

start() {
  if is_running; then
    echo "KW-Media is already running on port $PORT."
    exit 0
  fi
  echo "Starting KW-Media on port $PORT..."
  PORT=$PORT setsid node server.mjs </dev/null > "$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  sleep 1.5
  if is_running; then
    echo "Started (PID: $pid, Port: $PORT)"
  else
    echo "Failed to start. Check $LOGFILE"
    exit 1
  fi
}

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
    fi
    rm -f "$PIDFILE"
  fi
  local port_pid
  port_pid=$(ss -tulpn 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K\d+' | head -n 1 || true)
  if [ -n "$port_pid" ]; then
    kill "$port_pid" 2>/dev/null || true
  fi
  echo "Stopped."
}

status() {
  if is_running; then
    echo "Running"
  else
    echo "Stopped"
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *)       echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
