#!/usr/bin/env bash
#
# eliza-refresh-oauth.sh — keep the Claude Code OAuth refresh token rolling.
#
# Claude Code OAuth uses rolling refresh tokens: as long as the token is
# exercised periodically it never expires. This reads the `expiresAt` field in
# ~/.claude/.credentials.json and only calls `claude auth status` (which hits
# the auth endpoint and rolls the refresh token) when fewer than
# ELIZA_OAUTH_REFRESH_THRESHOLD_SECS remain. Otherwise it is a no-op. It never
# invokes a model.
#
# If the refresh token itself has expired (bot offline for a long time), this
# cannot help — run `claude auth login` once interactively.
set -euo pipefail

CRED="$HOME/.claude/.credentials.json"
THRESHOLD="${ELIZA_OAUTH_REFRESH_THRESHOLD_SECS:-3600}"
LOG="${ELIZA_OAUTH_LOG:-$HOME/.local/share/eliza/oauth-refresh.log}"

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date -Is)" "$1" >>"$LOG"; }

refresh() {
  if command -v claude >/dev/null 2>&1; then
    claude auth status --json >/dev/null 2>&1 || log "WARN: 'claude auth status' failed"
  else
    log "WARN: 'claude' CLI not on PATH; cannot refresh"
  fi
}

if [[ ! -r "$CRED" ]]; then
  log "no credentials at $CRED — run 'claude auth login' once. skipping."
  exit 0
fi

# Read expiresAt (epoch milliseconds). Prefer jq; fall back to a tolerant grep.
expires_ms=""
if command -v jq >/dev/null 2>&1; then
  expires_ms="$(jq -r '.. | .expiresAt? // empty' "$CRED" 2>/dev/null | head -1 || true)"
fi
if [[ -z "${expires_ms:-}" || ! "$expires_ms" =~ ^[0-9]+$ ]]; then
  expires_ms="$(grep -oE '"expiresAt"[[:space:]]*:[[:space:]]*[0-9]+' "$CRED" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)"
fi

if [[ -z "${expires_ms:-}" || ! "$expires_ms" =~ ^[0-9]+$ ]]; then
  log "could not read expiresAt; refreshing to be safe."
  refresh
  exit 0
fi

now_s="$(date +%s)"
remaining_s=$(( expires_ms / 1000 - now_s ))
if (( remaining_s < THRESHOLD )); then
  log "token expires in ${remaining_s}s (< ${THRESHOLD}s); refreshing."
  refresh
else
  log "token healthy (${remaining_s}s remaining); no-op."
fi
