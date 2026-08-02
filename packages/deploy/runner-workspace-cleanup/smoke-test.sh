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

# 4. The rendered UNIT delegates to the helper and carries no tool flags of its
#    own; the helper owns `--allow-active` (it proves per-runner inactivity
#    first, and the unit's ProtectProc=invisible confinement blinds the tool's
#    host-global pgrep guard anyway — see the helper for the full rationale).
if grep -q -- "--allow-active" "$svc"; then fail "the unit must delegate flags to the helper"; fi
grep -q -- "--allow-active" "$SCRIPT_DIR/bin/eliza-prune-idle-runner-workspaces.sh" \
  || fail "the idle helper must pass --allow-active (in-unit pgrep is blind under ProtectProc)"
# The helper must NOT run under `set -e`: one runner's failure (or the orphan
# grep-miss) would abort the sweep before later runners are processed.
if head -40 "$SCRIPT_DIR/bin/eliza-prune-idle-runner-workspaces.sh" | grep -qE "^set +-[a-z]*e"; then
  fail "the idle helper must not use set -e; per-runner errors are isolated instead"
fi

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

# 8. BEHAVIORAL: the prune reclaims a stale checkout, spares a fresh one, and
#    preserves live runner command pipes even when their parent mtime is stale.
#    This is driven through the real tool against a temporary runner tree.
mkdir -p "$RUNNER_ROOT/runner-1/_work/stale-repo" \
         "$RUNNER_ROOT/runner-1/_work/fresh-repo" \
         "$RUNNER_ROOT/runner-1/_work/_temp/_runner_file_commands"
echo payload > "$RUNNER_ROOT/runner-1/_work/stale-repo/file"
echo payload > "$RUNNER_ROOT/runner-1/_work/fresh-repo/file"
echo state > "$RUNNER_ROOT/runner-1/_work/_temp/_runner_file_commands/save_state_smoke"
# Age it through node: `touch -d "48 hours ago"` is GNU-only and the BSD `-A`
# form counts HHMMSS, so both silently mis-age this directory on macOS.
node -e '
  const fs = require("node:fs");
  const when = new Date(Date.now() - 48 * 3600 * 1000);
  for (const target of process.argv.slice(1)) {
    fs.utimesSync(target, when, when);
  }
' "$RUNNER_ROOT/runner-1/_work/stale-repo" \
  "$RUNNER_ROOT/runner-1/_work/_temp"

# `--allow-active` only because this assertion runs INSIDE a CI job, which is
# itself a live `Runner.Worker` the tool's host-global guard would refuse on —
# and `$RUNNER_ROOT` here is a mktemp tree, not a real runner root. The guard
# itself stays covered: check 4 above independently asserts the shipped unit
# never passes this flag.
"$BUN_BIN" "$TOOL_SRC" --root "$RUNNER_ROOT" --min-age-hours 6 --allow-active >/dev/null \
  || fail "prune run failed against the temporary runner tree"

test ! -e "$RUNNER_ROOT/runner-1/_work/stale-repo" || fail "stale checkout was not reclaimed"
test -e "$RUNNER_ROOT/runner-1/_work/fresh-repo" || fail "fresh checkout must be preserved"
test -e "$RUNNER_ROOT/runner-1/_work/_temp/_runner_file_commands/save_state_smoke" \
  || fail "runner file-command state must be preserved"

# 9. If systemd-analyze is available, verify rendered units whose paths point
#    at a temp staging of the REAL shipped files. The normal rendering above
#    targets the install-time /opt destinations, which do not exist pre-install,
#    and systemd-analyze hard-fails an ExecStart whose executable is missing —
#    so verifying that rendering would fail on every host that has the tool.
#    Staging the actual helper/tool/env keeps the executable-existence check
#    meaningful (it proves the shipped files are present and executable) while
#    still writing nothing outside mktemp.
if command -v systemd-analyze >/dev/null 2>&1; then
  STAGE_DIR="$TMP_DIR/stage"
  VERIFY_UNIT_DIR="$TMP_DIR/verify-units"
  mkdir -p "$STAGE_DIR" "$VERIFY_UNIT_DIR"
  install -m 0755 "$TOOL_SRC" "$STAGE_DIR/prune-runner-workspaces.ts"
  install -m 0755 "$SCRIPT_DIR/bin/eliza-prune-idle-runner-workspaces.sh" \
    "$STAGE_DIR/eliza-prune-idle-runner-workspaces.sh"
  cat > "$STAGE_DIR/cleanup.env" <<EOF_ENV
RUNNER_WORKSPACE_ROOT=$RUNNER_ROOT
PRUNE_MIN_AGE_HOURS=$MIN_AGE_HOURS
BUN_BIN=$BUN_BIN
PRUNE_TOOL=$STAGE_DIR/prune-runner-workspaces.ts
EOF_ENV
  for unit in "$SCRIPT_DIR"/units/*; do
    sed -e "s|__BUN__|$BUN_BIN|g" \
        -e "s|__TOOL__|$STAGE_DIR/prune-runner-workspaces.ts|g" \
        -e "s|__HELPER__|$STAGE_DIR/eliza-prune-idle-runner-workspaces.sh|g" \
        -e "s|__ENV_FILE__|$STAGE_DIR/cleanup.env|g" \
        -e "s|__RUNNER_ROOT__|$RUNNER_ROOT|g" \
        -e "s|__MIN_AGE_HOURS__|$MIN_AGE_HOURS|g" \
        "$unit" > "$VERIFY_UNIT_DIR/$(basename "$unit")"
  done
  systemd-analyze verify \
    "$VERIFY_UNIT_DIR/eliza-runner-workspace-prune.service" \
    "$VERIFY_UNIT_DIR/eliza-runner-workspace-prune.timer" \
    || fail "systemd-analyze rejected the rendered units"
fi

# 10. BEHAVIORAL: the idle helper sweeps EVERY orphaned runner — the exact
#     #15398 case. A deregistered runner's agentName matches no unit, which
#     under the old `set -e` aborted the sweep at the FIRST orphan (the grep
#     miss propagated through the command substitution), so a second orphan was
#     never processed. Driven through the REAL helper + REAL tool with only
#     systemctl stubbed to "no units exist".
STUB_DIR="$TMP_DIR/stub-bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/systemctl" <<'EOF_STUB'
#!/usr/bin/env bash
case "${1:-}" in
  list-units) exit 0 ;;   # no actions.runner.* units: every runner is orphaned
  is-active)  exit 3 ;;   # inactive
  *)          exit 0 ;;
esac
EOF_STUB
chmod +x "$STUB_DIR/systemctl"

SWEEP_ROOT="$TMP_DIR/sweep-root"
for r in runner-a runner-b; do
  mkdir -p "$SWEEP_ROOT/$r/_work/stale-repo"
  echo payload > "$SWEEP_ROOT/$r/_work/stale-repo/file"
  printf '{"agentName": "%s"}\n' "$r" > "$SWEEP_ROOT/$r/.runner"
  node -e '
    const fs = require("node:fs");
    const when = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(process.argv[1], when, when);
  ' "$SWEEP_ROOT/$r/_work/stale-repo"
done

PATH="$STUB_DIR:$PATH" \
RUNNER_WORKSPACE_ROOT="$SWEEP_ROOT" \
PRUNE_MIN_AGE_HOURS=6 \
BUN_BIN="$BUN_BIN" \
PRUNE_TOOL="$TOOL_SRC" \
  bash "$SCRIPT_DIR/bin/eliza-prune-idle-runner-workspaces.sh" >"$TMP_DIR/sweep.log" 2>&1 \
  || fail "idle sweep exited nonzero on a clean orphan sweep: $(cat "$TMP_DIR/sweep.log")"

test ! -e "$SWEEP_ROOT/runner-a/_work/stale-repo" \
  || fail "first orphaned runner was not pruned"
test ! -e "$SWEEP_ROOT/runner-b/_work/stale-repo" \
  || fail "second orphaned runner was not pruned — the sweep stopped at the first (set -e regression)"
grep -q "pruned=2" "$TMP_DIR/sweep.log" || fail "sweep did not report pruned=2: $(cat "$TMP_DIR/sweep.log")"

echo "runner-workspace-cleanup smoke OK (behavioral)"
