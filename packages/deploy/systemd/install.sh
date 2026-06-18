#!/usr/bin/env bash
#
# install.sh — install Eliza as systemd *user* services (bot + OAuth refresh +
# health probe). Idempotent: safe to re-run after a git pull to pick up changes.
#
# Usage:
#   ./packages/deploy/systemd/install.sh [WORKDIR]
#
# WORKDIR defaults to the repo root that contains this script. Pass an absolute
# path if the checkout you want the service to run lives elsewhere (e.g.
# /opt/eliza).
#
# See docs: /deployment-bare-metal  (packages/docs/deployment-bare-metal.mdx)
set -euo pipefail

# --- resolve paths ------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKDIR="${1:-$REPO_ROOT}"
WORKDIR="$(cd "$WORKDIR" && pwd)"  # normalize to absolute

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Refusing to run as root — these are user-level services. Run as your normal user." >&2
  exit 1
fi

BUN_BIN="$(command -v bun || true)"
if [[ -z "$BUN_BIN" ]]; then
  echo "bun not found on PATH. Install bun and re-run." >&2
  exit 1
fi

LOG_PATH="${ELIZA_LOG:-$HOME/.local/share/eliza/bot.log}"

UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/bin"
ENV_DIR="$HOME/.config/eliza"
STATE_DIR="$HOME/.local/share/eliza"

echo "Installing Eliza systemd user services"
echo "  workdir : $WORKDIR"
echo "  bun     : $BUN_BIN"
echo "  log     : $LOG_PATH"

mkdir -p "$UNIT_DIR" "$BIN_DIR" "$ENV_DIR" "$STATE_DIR" "$(dirname "$LOG_PATH")"

# --- helper scripts -----------------------------------------------------------
install -m 0755 "$SCRIPT_DIR/bin/eliza-refresh-oauth.sh" "$BIN_DIR/eliza-refresh-oauth.sh"
install -m 0755 "$SCRIPT_DIR/bin/eliza-health-probe.sh"  "$BIN_DIR/eliza-health-probe.sh"

# --- environment (first install only; never clobber the operator's edits) -----
if [[ ! -f "$ENV_DIR/env" ]]; then
  cp "$SCRIPT_DIR/eliza.env.example" "$ENV_DIR/env"
  echo "  wrote   : $ENV_DIR/env (from template — edit to taste)"
else
  echo "  kept    : $ENV_DIR/env (already present)"
fi

# --- units: substitute template tokens, write to the user unit dir ------------
render_unit() {
  local src="$1" dst="$2"
  sed -e "s|__WORKDIR__|$WORKDIR|g" \
      -e "s|__BUN__|$BUN_BIN|g" \
      -e "s|__LOG__|$LOG_PATH|g" \
      "$src" > "$dst"
}

render_unit "$SCRIPT_DIR/units/eliza.service"          "$UNIT_DIR/eliza.service"
render_unit "$SCRIPT_DIR/units/eliza-refresh.service"  "$UNIT_DIR/eliza-refresh.service"
render_unit "$SCRIPT_DIR/units/eliza-refresh.timer"    "$UNIT_DIR/eliza-refresh.timer"
render_unit "$SCRIPT_DIR/units/eliza-probe.service"    "$UNIT_DIR/eliza-probe.service"
render_unit "$SCRIPT_DIR/units/eliza-probe.timer"      "$UNIT_DIR/eliza-probe.timer"

# --- linger so user services survive logout / run at boot ---------------------
if ! loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q "Linger=yes"; then
  echo "  enabling linger (may prompt for sudo)…"
  loginctl enable-linger "$USER" 2>/dev/null \
    || sudo loginctl enable-linger "$USER" \
    || echo "  WARN: could not enable linger; services won't run when logged out." >&2
fi

# --- (re)load + start ---------------------------------------------------------
systemctl --user daemon-reload
systemctl --user enable --now eliza.service eliza-refresh.timer eliza-probe.timer

echo
echo "Done. Useful commands:"
echo "  systemctl --user status eliza.service"
echo "  journalctl --user -u eliza.service -f"
echo "  systemctl --user list-timers 'eliza*'"
