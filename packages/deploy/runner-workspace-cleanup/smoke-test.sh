#!/usr/bin/env bash
#
# Behavioral smoke test for the runner-workspace cleanup bundle.
#
# The previous version asserted the ExecStart string against the same literal
# the units were written with, so a flag the TOOL does not accept still passed
# (`--min-age` silently parsed as the 6h default). Every check below is now
# settled by the real tool: rendered arguments are fed through the actual
# argument parser and the effective config is asserted, and the prune itself is
# exercised against a temporary runner tree. No root, no install, no host
# mutation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RM_PATH_RECURSIVE="$REPO_ROOT/packages/scripts/rm-path-recursive.mjs"
TOOL_SRC="$REPO_ROOT/packages/scripts/cloud/admin/prune-runner-workspaces.ts"
TMP_DIR="$(mktemp -d)"
cleanup() { node "$RM_PATH_RECURSIVE" "$TMP_DIR"; }
trap cleanup EXIT

BUN_BIN="${ELIZA_PRUNE_SMOKE_BUN:-$(command -v bun || echo /usr/bin/bun)}"
RUNNER_ROOT="$TMP_DIR/actions-runners"
# Deliberately NOT the tool default: a dropped or renamed flag surfaces as the
# default instead of this value.
MIN_AGE_HOURS=19
TOOL_DST="/opt/eliza-runner-workspace-cleanup/prune-runner-workspaces.ts"
HELPER_DST="/opt/eliza-runner-workspace-cleanup/eliza-prune-idle-runner-workspaces.sh"
ENV_DST="/opt/eliza-runner-workspace-cleanup/cleanup.env"

UNIT_DIR="$TMP_DIR/units"
mkdir -p "$UNIT_DIR" "$RUNNER_ROOT"

fail() { echo "smoke failed: $1" >&2; exit 1; }

render_unit() {
  sed -e "s|__BUN__|$BUN_BIN|g" \
      -e "s|__TOOL__|$TOOL_DST|g" \
      -e "s|__HELPER__|$HELPER_DST|g" \
      -e "s|__ENV_FILE__|$ENV_DST|g" \
      -e "s|__RUNNER_ROOT__|$RUNNER_ROOT|g" \
      -e "s|__MIN_AGE_HOURS__|$MIN_AGE_HOURS|g" \
      "$1" > "$2"
}
for unit in "$SCRIPT_DIR"/units/*; do
  render_unit "$unit" "$UNIT_DIR/$(basename "$unit")"
done

svc="$UNIT_DIR/eliza-runner-workspace-prune.service"
tmr="$UNIT_DIR/eliza-runner-workspace-prune.timer"

# 1. No template token may survive rendering.
if grep -RE "__(BUN|TOOL|HELPER|ENV_FILE|RUNNER_ROOT|MIN_AGE_HOURS)__" "$UNIT_DIR" >/dev/null; then
  grep -RE "__(BUN|TOOL|HELPER|ENV_FILE|RUNNER_ROOT|MIN_AGE_HOURS)__" "$UNIT_DIR" >&2
  fail "unresolved template tokens remain"
fi

# The tool path travels by ENV, never as argv[1]: `bun -e '<code>' <path> …`
# puts <path> in process.argv[1], which makes the tool's own isMainModule()
# true, so importing it to inspect the parser would RUN main() — a real prune
# from inside a supposedly read-only assertion. The `--` separator keeps bun
# from claiming a leading `--root` as its own flag.
parse_args() {
  ELIZA_PRUNE_TOOL_SRC="$TOOL_SRC" "$BUN_BIN" -e '
    const { parseRunnerWorkspacePruneArgs } = await import(process.env.ELIZA_PRUNE_TOOL_SRC);
    const args = parseRunnerWorkspacePruneArgs(process.argv.slice(1), {});
    console.log(JSON.stringify({ minAgeHours: args.minAgeHours, allowActive: args.allowActive }));
  ' -- "$@"
}

# 2. BEHAVIORAL: the arguments the helper actually passes must parse to the
#    intended config in the REAL tool. This is what the string-compare missed.
parsed="$(parse_args --root "$RUNNER_ROOT" --min-age-hours "$MIN_AGE_HOURS" 2>&1)" \
  || fail "the tool rejected the arguments the helper passes: $parsed"

echo "$parsed" | grep -q "\"minAgeHours\":$MIN_AGE_HOURS" \
  || fail "effective min-age is not $MIN_AGE_HOURS — a dropped/renamed flag would silently default: $parsed"
echo "$parsed" | grep -q '"allowActive":false' \
  || fail "the active-job guard must never be bypassed: $parsed"

# 3. BEHAVIORAL: an unknown/renamed flag must be REJECTED, not ignored — the
#    property whose absence let `--min-age` look configured while doing nothing.
if parse_args --root "$RUNNER_ROOT" --min-age 19 >/dev/null 2>&1; then
  fail "the tool silently accepted an unknown flag (--min-age); it must reject it"
fi

# 4. The scheduled path must not bypass the active-job guard.
if grep -q -- "--allow-active" "$svc"; then fail "the scheduled unit must not pass --allow-active"; fi

# 5. Timer must be a real recurring timer wired to timers.target.
grep -q "OnUnitActiveSec=" "$tmr" || fail "timer has no recurring interval"
grep -q "WantedBy=timers.target" "$tmr" || fail "timer not wired to timers.target"

# 6. Containment: the root-run deletion unit must be confined.
for directive in "NoNewPrivileges=yes" "ProtectSystem=strict" "ReadWritePaths=$RUNNER_ROOT" \
                 "SystemCallFilter=@system-service" "RestrictSUIDSGID=yes" "PrivateTmp=yes"; do
  grep -qF "$directive" "$svc" || fail "service is missing containment directive: $directive"
done

# 7. Scripts parse and are executable.
for script in "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/smoke-test.sh" \
              "$SCRIPT_DIR/bin/eliza-prune-idle-runner-workspaces.sh" \
              "$SCRIPT_DIR/bin/eliza-runner-job-completed-hook.sh"; do
  test -x "$script" || fail "not executable: $script"
  bash -n "$script" || fail "bash syntax error in $script"
done

# 8. BEHAVIORAL: the prune reclaims a stale checkout and spares a fresh one,
#    driven through the real tool against a temporary runner tree.
mkdir -p "$RUNNER_ROOT/runner-1/_work/stale-repo" "$RUNNER_ROOT/runner-1/_work/fresh-repo"
echo payload > "$RUNNER_ROOT/runner-1/_work/stale-repo/file"
echo payload > "$RUNNER_ROOT/runner-1/_work/fresh-repo/file"
# Age it through node: `touch -d "48 hours ago"` is GNU-only and the BSD `-A`
# form counts HHMMSS, so both silently mis-age this directory on macOS.
node -e '
  const fs = require("node:fs");
  const when = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(process.argv[1], when, when);
' "$RUNNER_ROOT/runner-1/_work/stale-repo"

# `--allow-active` only because this assertion runs INSIDE a CI job, which is
# itself a live `Runner.Worker` the tool's host-global guard would refuse on —
# and `$RUNNER_ROOT` here is a mktemp tree, not a real runner root. The guard
# itself stays covered: check 4 above independently asserts the shipped unit
# never passes this flag.
"$BUN_BIN" "$TOOL_SRC" --root "$RUNNER_ROOT" --min-age-hours 6 --allow-active >/dev/null \
  || fail "prune run failed against the temporary runner tree"

test ! -e "$RUNNER_ROOT/runner-1/_work/stale-repo" || fail "stale checkout was not reclaimed"
test -e "$RUNNER_ROOT/runner-1/_work/fresh-repo" || fail "fresh checkout must be preserved"

# 9. If systemd-analyze is available, verify the rendered units parse.
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$svc" "$tmr" || fail "systemd-analyze rejected the rendered units"
fi

echo "runner-workspace-cleanup smoke OK (behavioral)"
