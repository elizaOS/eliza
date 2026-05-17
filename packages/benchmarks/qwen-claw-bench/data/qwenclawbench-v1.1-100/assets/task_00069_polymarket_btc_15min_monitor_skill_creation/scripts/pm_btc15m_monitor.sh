#!/usr/bin/env bash
# pm_btc15m_monitor.sh — Polymarket BTC 15min Up/Down round monitor
# Used by cron job to check for new resolved rounds
# 
# Usage: ./pm_btc15m_monitor.sh [--dry-run]
#
# Reads last reported round from STATE_FILE, fetches latest from Polymarket,
# compares, and outputs result or NO-UPDATE.

set -euo pipefail

STATE_FILE="${PM_STATE_FILE:-/home/rico/.openclaw/data/pm_btc15m_last_reported.txt}"
PM_URL="https://polymarket.com/crypto/15M"
TZ_TARGET="Asia/Tokyo"

# Parse last reported round
get_last_round() {
    if [[ -f "$STATE_FILE" ]]; then
        head -1 "$STATE_FILE" | cut -d'|' -f1 | sed 's/^ROUND://'
    else
        echo "NONE"
    fi
}

# Format timestamp to Asia/Tokyo
to_jst() {
    local ts="$1"
    TZ="$TZ_TARGET" date -d "$ts" '+%Y-%m-%d %H:%M:%S JST' 2>/dev/null || echo "$ts"
}

# Main
main() {
    local dry_run=false
    [[ "${1:-}" == "--dry-run" ]] && dry_run=true

    local last_round
    last_round=$(get_last_round)

    echo "[INFO] Last reported round: $last_round"
    echo "[INFO] Fetching $PM_URL ..."

    # In production, this would use curl/web_fetch
    # The OpenClaw agent handles the actual fetching via web_fetch tool
    echo "DATA-ERROR: Direct fetch not implemented in shell — use OpenClaw web_fetch or browser tool"
}

main "$@"
