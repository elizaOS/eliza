#!/usr/bin/env bash
#
# eliza-health-probe.sh — active health check; restart the bot if unhealthy.
#
# Checks, every run (driven by eliza-probe.timer):
#   1. GET /api/health responds within 5s,
#   2. the body reports "agentState":"running",
#   3. the last 50 bot-log lines contain no "Authentication failed".
# Any failure triggers `systemctl --user restart eliza.service`. The probe
# itself always exits 0 — a restart is normal recovery, not a unit failure.
set -uo pipefail

PORT="${ELIZA_API_PORT:-31337}"
LOG="${ELIZA_PROBE_LOG:-$HOME/.local/share/eliza/probe.log}"
BOTLOG="${ELIZA_LOG:-$HOME/.local/share/eliza/bot.log}"

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date -Is)" "$1" >>"$LOG"; }
restart() {
  log "UNHEALTHY: $1 — restarting eliza.service"
  systemctl --user restart eliza.service || log "WARN: restart command failed"
  exit 0
}

body="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
[[ -z "$body" ]] && restart "no /api/health response within 5s"

# Tolerant of whitespace in the JSON body.
if ! printf '%s' "$body" | tr -d '[:space:]' | grep -q '"agentState":"running"'; then
  restart "agentState not running"
fi

if [[ -r "$BOTLOG" ]] && tail -n 50 "$BOTLOG" 2>/dev/null | grep -q "Authentication failed"; then
  restart "Authentication failed in recent logs"
fi

# Sparse heartbeat: one line near the top of each hour so the log isn't silent.
if (( 10#$(date +%M) < 5 )); then
  log "healthy"
fi
exit 0
