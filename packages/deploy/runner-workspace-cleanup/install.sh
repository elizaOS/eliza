#!/usr/bin/env bash
#
# install.sh — install the runner-workspace prune as a systemd *system* timer.
#
# Wires the host-local tool `packages/scripts/cloud/admin/prune-runner-workspaces.ts`
# (#15504) into a scheduled unit so a robot host that doubles as a self-hosted
# GitHub Actions runner reclaims stale `_work` checkouts on its own — the gap
# behind #15398 (prod-2 refilled to 100% because the tool was never scheduled).
#
# System-level (root) on purpose: the runners' `_work` lives under a root-owned
# `/opt/actions-runners`, unlike the user-level bot bundle in ../systemd/.
# Idempotent: safe to re-run after a git pull to pick up changes.
#
# Usage (as root, on a runner host):
#   ./packages/deploy/runner-workspace-cleanup/install.sh
#
# Tunables (env at install time; baked into the rendered unit):
#   RUNNER_WORKSPACE_ROOT   runners' work root      (default /opt/actions-runners)
#   PRUNE_MIN_AGE_HOURS     min checkout age to prune (default 6)
#   BUN_BIN                 bun binary               (default: first on PATH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Must run as root — the timer prunes the root-owned runner work root and installs system units." >&2
  exit 1
fi

RUNNER_ROOT="${RUNNER_WORKSPACE_ROOT:-/opt/actions-runners}"
MIN_AGE_HOURS="${PRUNE_MIN_AGE_HOURS:-6}"
if ! [[ "$MIN_AGE_HOURS" =~ ^[0-9]+$ ]] || (( MIN_AGE_HOURS < 1 )); then
  echo "PRUNE_MIN_AGE_HOURS must be an integer >= 1 (got '$MIN_AGE_HOURS')." >&2
  exit 1
fi

BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "bun not found. Install bun or set BUN_BIN=/path/to/bun and re-run." >&2
  exit 1
fi

SRC_TOOL="$REPO_ROOT/packages/scripts/cloud/admin/prune-runner-workspaces.ts"
if [[ ! -f "$SRC_TOOL" ]]; then
  echo "prune tool not found at $SRC_TOOL — is this the eliza repo root?" >&2
  exit 1
fi

# The tool is zero-dependency (node built-ins only), so a single-file copy runs
# standalone — the robot host needs neither a full checkout nor node_modules.
TOOL_DIR="/opt/eliza-runner-workspace-cleanup"
TOOL_DST="$TOOL_DIR/prune-runner-workspaces.ts"
HELPER_DST="$TOOL_DIR/eliza-prune-idle-runner-workspaces.sh"
HOOK_DST="$TOOL_DIR/eliza-runner-job-completed-hook.sh"
ENV_DST="$TOOL_DIR/cleanup.env"
UNIT_DIR="/etc/systemd/system"

echo "Installing runner-workspace prune timer"
echo "  runner root : $RUNNER_ROOT"
echo "  min age     : ${MIN_AGE_HOURS}h"
echo "  bun         : $BUN_BIN"
echo "  tool        : $TOOL_DST"

install -d -m 0755 "$TOOL_DIR"
install -m 0755 "$SRC_TOOL" "$TOOL_DST"
install -m 0755 "$SCRIPT_DIR/bin/eliza-prune-idle-runner-workspaces.sh" "$HELPER_DST"
install -m 0755 "$SCRIPT_DIR/bin/eliza-runner-job-completed-hook.sh" "$HOOK_DST"

# The helpers read their config from the environment; write it once so the unit
# and the runner hook share exactly one source of truth.
cat > "$ENV_DST" <<EOF_ENV
RUNNER_WORKSPACE_ROOT=$RUNNER_ROOT
PRUNE_MIN_AGE_HOURS=$MIN_AGE_HOURS
BUN_BIN=$BUN_BIN
PRUNE_TOOL=$TOOL_DST
EOF_ENV
chmod 0644 "$ENV_DST"

render_unit() {
  local src="$1" dst="$2"
  sed -e "s|__BUN__|$BUN_BIN|g" \
      -e "s|__TOOL__|$TOOL_DST|g" \
      -e "s|__HELPER__|$HELPER_DST|g" \
      -e "s|__ENV_FILE__|$ENV_DST|g" \
      -e "s|__RUNNER_ROOT__|$RUNNER_ROOT|g" \
      -e "s|__MIN_AGE_HOURS__|$MIN_AGE_HOURS|g" \
      "$src" > "$dst"
}

render_unit "$SCRIPT_DIR/units/eliza-runner-workspace-prune.service" \
  "$UNIT_DIR/eliza-runner-workspace-prune.service"
render_unit "$SCRIPT_DIR/units/eliza-runner-workspace-prune.timer" \
  "$UNIT_DIR/eliza-runner-workspace-prune.timer"

systemctl daemon-reload
systemctl enable --now eliza-runner-workspace-prune.timer

echo
echo "Installed the IDLE-runner timer. Active runners are covered race-free by"
echo "their own job-completed hook — wire it once per runner (as the runner user):"
echo "  echo 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$HOOK_DST' >> <runner-dir>/.env"
echo "  systemctl restart <that runner's actions.runner.* unit>"
echo
echo "Verify:"
echo "  systemctl list-timers eliza-runner-workspace-prune.timer"
echo "  systemctl start eliza-runner-workspace-prune.service   # run once now"
echo "  journalctl -u eliza-runner-workspace-prune.service -n 50"
echo "  # dry-run without the timer:"
echo "  $BUN_BIN $TOOL_DST --root $RUNNER_ROOT --min-age-hours $MIN_AGE_HOURS --dry-run"
