#!/usr/bin/env bash
#
# eliza-runner-job-completed-hook.sh — hook half of the cleanup (#15398).
#
# Wired as `ACTIONS_RUNNER_HOOK_JOB_COMPLETED`, so the runner itself invokes it
# after a job finishes, in that runner's own context. That is what makes it
# race-free: the runner is between jobs by construction while this runs, so
# nothing can be writing the workspace we prune. It is scoped to this runner's
# own `_work` and never touches a sibling runner.
#
# Never fail the job: a cleanup problem is not a build failure. Always exit 0.
set -uo pipefail

log() { printf '[eliza-runner-cleanup] %s\n' "$1"; }

# The runner exports only ACTIONS_RUNNER_HOOK_JOB_COMPLETED, so read the config
# the installer wrote rather than hoping it is in the inherited environment —
# without this the hook took its skip branch on every job and pruned nothing.
CLEANUP_ENV="${ELIZA_CLEANUP_ENV:-/opt/eliza-runner-workspace-cleanup/cleanup.env}"
if [[ -r "$CLEANUP_ENV" ]]; then
  # shellcheck disable=SC1090
  . "$CLEANUP_ENV"
fi

BUN="${BUN_BIN:-}"
TOOL="${PRUNE_TOOL:-}"
MIN_AGE_HOURS="${PRUNE_MIN_AGE_HOURS:-6}"

if [[ -z "$BUN" || -z "$TOOL" ]]; then
  log "no cleanup config at $CLEANUP_ENV and BUN_BIN/PRUNE_TOOL unset — skipping"
  exit 0
fi

# `RUNNER_WORKSPACE` is <runner>/_work/<repo>; the runner root is two levels up.
# Fall back to the hook's own location only if the runner did not export it.
runner_dir=""
if [[ -n "${RUNNER_WORKSPACE:-}" ]]; then
  runner_dir="$(cd "$RUNNER_WORKSPACE/../.." 2>/dev/null && pwd || true)"
fi
if [[ -z "$runner_dir" && -n "${RUNNER_ROOT_DIR:-}" ]]; then
  runner_dir="$RUNNER_ROOT_DIR"
fi

if [[ -z "$runner_dir" || ! -d "$runner_dir/_work" ]]; then
  log "could not resolve this runner's _work (RUNNER_WORKSPACE=${RUNNER_WORKSPACE:-unset}) — skipping"
  exit 0
fi

# `--allow-active` is REQUIRED here, and it is not a weakening. The tool's guard
# greps the HOST for any `Runner.Worker`, and this hook is executed BY the
# Runner.Worker of the job that just finished — so the guard would always see
# itself and refuse, leaving the hook a permanent no-op. Safety comes from scope
# instead: `--root` is this runner's own directory (never a sibling's), this
# runner is between jobs by construction while its own hook runs, and
# `--min-age-hours` still spares the workspace the job just used.
log "pruning stale workspaces in $runner_dir (min age ${MIN_AGE_HOURS}h)"
if ! "$BUN" "$TOOL" --root "$runner_dir" --min-age-hours "$MIN_AGE_HOURS" --allow-active; then
  log "prune failed — leaving the workspace as-is; the idle timer will retry"
fi
exit 0
