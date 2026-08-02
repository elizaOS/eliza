#!/usr/bin/env bash
#
# eliza-prune-idle-runner-workspaces.sh — timer half of the cleanup (#15398).
#
# Prunes the `_work` tree of runners that are **not running**. An inactive
# runner cannot accept a job, so there is no check-then-delete race: the
# process that would write the directory does not exist and cannot be started
# by GitHub while its unit is stopped.
#
# Runners that ARE active are deliberately skipped here — they are covered,
# race-free, by the job-completed hook (eliza-runner-job-completed-hook.sh),
# which only ever runs between jobs on that runner.
#
# Env (rendered into the unit at install time):
#   RUNNER_WORKSPACE_ROOT   runners' work root
#   PRUNE_MIN_AGE_HOURS     minimum checkout age to prune
#   BUN_BIN / PRUNE_TOOL    runtime + tool path
# NO `set -e`: one runner's failure must not stop the sweep. Errors are
# isolated per runner, counted, and surfaced in the exit code at the end.
set -uo pipefail

ROOT="${RUNNER_WORKSPACE_ROOT:?RUNNER_WORKSPACE_ROOT is required}"
MIN_AGE_HOURS="${PRUNE_MIN_AGE_HOURS:?PRUNE_MIN_AGE_HOURS is required}"
BUN="${BUN_BIN:?BUN_BIN is required}"
TOOL="${PRUNE_TOOL:?PRUNE_TOOL is required}"

[[ -d "$ROOT" ]] || { echo "no runner root at $ROOT — nothing to do"; exit 0; }

pruned=0
skipped_active=0
skipped_undeterminable=0
failed=0

for runner_dir in "$ROOT"/*/; do
  [[ -d "$runner_dir" ]] || continue
  [[ -d "${runner_dir}_work" ]] || continue
  name="$(basename "$runner_dir")"

  # GitHub's service installer records the exact generated unit name here.
  # Deriving it from agentName is unsafe because service-name normalization and
  # truncation are not reversible, and suffix searches can select a sibling.
  service_binding="${runner_dir}.service"
  unit=""
  undeterminable=""
  if [[ -e "$service_binding" ]]; then
    if [[ -f "$service_binding" && -r "$service_binding" ]]; then
      unit="$(<"$service_binding")"
      if [[ "$unit" != actions.runner.*.service || "$unit" == *[[:space:]]* ]]; then
        undeterminable="invalid .service binding"
      fi
    else
      undeterminable="unreadable .service binding"
    fi
  elif [[ -e "${runner_dir}.runner" ]]; then
    undeterminable="configured runner has no .service binding"
  fi

  if [[ -n "$undeterminable" ]]; then
    echo "skip $name — $undeterminable; cannot prove this runner is idle, refusing to prune"
    skipped_undeterminable=$((skipped_undeterminable + 1))
    continue
  fi

  if [[ -n "$unit" ]]; then
    active_state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$active_state" in
      active)
        # Active runner: the hook owns this one. Skipping is the race-free choice.
        echo "skip $name — runner unit active ($unit); job-completed hook owns it"
        skipped_active=$((skipped_active + 1))
        continue
        ;;
      inactive) ;;
      *)
        echo "skip $name — runner unit state is ${active_state:-unknown} ($unit); refusing to prune"
        skipped_undeterminable=$((skipped_undeterminable + 1))
        continue
        ;;
    esac
  fi

  if [[ -z "$unit" ]]; then
    # No runner or service configuration remains, so this is a directory left
    # behind by a removed runner rather than a runnable installation.
    echo "prune $name — no runner configuration remains (orphaned)"
  else
    echo "prune $name — runner unit inactive ($unit)"
  fi

  # `--allow-active` is REQUIRED here, for the same reason as in the hook: the
  # tool's built-in guard is a host-global `pgrep -f Runner.Worker`, which is
  # the wrong scope for a per-runner prune (a job on runner-3 must not veto
  # pruning the inactive runner-7) — and inside this unit's confinement
  # (ProtectProc=invisible, no CAP_SYS_PTRACE) pgrep cannot see other users'
  # processes at all, so the guard would be silently blind rather than
  # protective. Safety comes from the per-runner proof above instead: the
  # runner's OWN unit is inactive or unresolvable, so nothing can be writing
  # this workspace.
  if "$BUN" "$TOOL" --root "$runner_dir" --min-age-hours "$MIN_AGE_HOURS" --allow-active; then
    pruned=$((pruned + 1))
  else
    echo "FAILED $name — prune exited nonzero; continuing with the next runner" >&2
    failed=$((failed + 1))
  fi
done

echo "idle-prune done: pruned=$pruned skipped_active=$skipped_active skipped_undeterminable=$skipped_undeterminable failed=$failed"
# Surface degraded sweeps to systemd without having let one bad runner stop
# the others.
[[ "$failed" -eq 0 ]] || exit 1
exit 0
