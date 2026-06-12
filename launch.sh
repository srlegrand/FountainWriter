#!/bin/bash
# FountainWriter launcher — starts server if not already running, then opens browser

PORT=3737
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if curl -sf "http://localhost:$PORT" > /dev/null 2>&1; then
  # Already running — just open the browser
  xdg-open "http://localhost:$PORT"
else
  # Start the server
  cd "$DIR"
  node server.js &
  # Wait up to 10s for it to come up
  for i in $(seq 1 10); do
    sleep 1
    if curl -sf "http://localhost:$PORT" > /dev/null 2>&1; then
      break
    fi
  done
  xdg-open "http://localhost:$PORT"
fi
