#!/usr/bin/env bash
#
# Static smoke test for the bare-metal systemd bundle.
#
# This renders unit templates into a temporary directory and validates the
# deploy contract without installing user services or mutating the host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RM_PATH_RECURSIVE="$REPO_ROOT/packages/scripts/rm-path-recursive.mjs"
TMP_DIR="$(mktemp -d)"
cleanup() {
  node "$RM_PATH_RECURSIVE" "$TMP_DIR"
}
trap cleanup EXIT

WORKDIR="${ELIZA_SYSTEMD_SMOKE_WORKDIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
BUN_BIN="${ELIZA_SYSTEMD_SMOKE_BUN:-$(command -v bun || true)}"
LOG_PATH="${ELIZA_SYSTEMD_SMOKE_LOG:-$TMP_DIR/eliza.log}"

if [[ -z "$BUN_BIN" ]]; then
  BUN_BIN="/usr/bin/bun"
fi

UNIT_DIR="$TMP_DIR/units"
VERIFY_HOME="$TMP_DIR/home"
VERIFY_UNIT_DIR="$TMP_DIR/verify-units"
mkdir -p "$UNIT_DIR" "$VERIFY_UNIT_DIR" "$VERIFY_HOME/bin" "$(dirname "$LOG_PATH")"

render_unit() {
  local src="$1" dst="$2"
  sed -e "s|__WORKDIR__|$WORKDIR|g" \
      -e "s|__BUN__|$BUN_BIN|g" \
      -e "s|__LOG__|$LOG_PATH|g" \
      "$src" > "$dst"
}

for unit in "$SCRIPT_DIR"/units/*; do
  render_unit "$unit" "$UNIT_DIR/$(basename "$unit")"
done

if grep -R "__WORKDIR__\\|__BUN__\\|__LOG__" "$UNIT_DIR" >/dev/null; then
  echo "systemd smoke failed: unresolved template tokens remain" >&2
  grep -R "__WORKDIR__\\|__BUN__\\|__LOG__" "$UNIT_DIR" >&2
  exit 1
fi

for helper in "$SCRIPT_DIR"/bin/*.sh; do
  test -x "$helper"
  bash -n "$helper"
  cp "$helper" "$VERIFY_HOME/bin/$(basename "$helper")"
done

bash -n "$SCRIPT_DIR/install.sh"

if command -v systemd-analyze >/dev/null 2>&1; then
  for unit in "$UNIT_DIR"/*; do
    sed "s|%h|$VERIFY_HOME|g" "$unit" > "$VERIFY_UNIT_DIR/$(basename "$unit")"
  done
  systemd-analyze verify "$VERIFY_UNIT_DIR"/*.service "$VERIFY_UNIT_DIR"/*.timer
else
  echo "systemd-analyze not found; skipped unit parser verification"
fi

echo "systemd bundle smoke passed"
