#!/usr/bin/env bash
# Repairs one general-farm runner slot after a duplicate-listener diagnostic
# collision (elizaOS/eliza#19708 pattern): stops the slot's unit, reaps any
# listener chains the old KillMode=process policy abandoned, preserves the
# colliding _diag/pages directory to a timestamped sibling, installs the
# repository's canonical KillMode=control-group template unit, restarts only
# this slot, and proves exactly one listener owns it.
#
# Run as root on the runner host: repair-runner-slot.sh <slot> [--apply]
# Without --apply it is a read-only dry run that prints every planned action.
# It never touches sibling slots, runner labels, or HETZNER_FLEET_ONLINE.
#
# The ELIZA_RUNNER_* variables below exist only so the fake-host harness in
# tests/runner-farm-repair.test.ts can drive this script for real. They are
# refused unless ELIZA_RUNNER_FAKE_HOST=1 is set explicitly, so an inherited
# environment (sudo -E, a wrapper script) cannot redirect a real repair.

set -euo pipefail

usage() {
  echo "usage: $0 <slot-number> [--apply]" >&2
  exit 64
}

slot=""
apply=false
for arg in "$@"; do
  case "$arg" in
    --apply) $apply && usage; apply=true ;;
    -*) usage ;;
    *) [ -z "$slot" ] || usage; slot="$arg" ;;
  esac
done
case "$slot" in
  '' | *[!0-9]*) usage ;;
esac

unit="actions-runner@${slot}.service"

fake_host="${ELIZA_RUNNER_FAKE_HOST:-0}"
default_runners_root=/opt/actions-runners
default_unit_dst=/etc/systemd/system/actions-runner@.service
runners_root="${ELIZA_RUNNERS_ROOT:-$default_runners_root}"
unit_dst="${ELIZA_RUNNER_UNIT_PATH:-$default_unit_dst}"
# Seconds to wait for processes to exit / the first listener to appear, and to
# keep re-sampling afterwards before declaring single ownership.
settle_secs="${ELIZA_RUNNER_SETTLE_SECS:-30}"
confirm_secs="${ELIZA_RUNNER_CONFIRM_SECS:-10}"
proc_root="${ELIZA_RUNNER_PROC_ROOT:-/proc}"
# Seconds between samples; the counters above are expressed in samples.
poll_interval="${ELIZA_RUNNER_POLL_INTERVAL:-1}"
# Indirection so the harness can substitute a stub; with the default value the
# word expands to bash's own `kill` builtin.
kill_cmd="${ELIZA_RUNNER_KILL_CMD:-kill}"

if [ "$fake_host" != 1 ]; then
  for override in ELIZA_RUNNERS_ROOT ELIZA_RUNNER_UNIT_PATH \
    ELIZA_RUNNER_SETTLE_SECS ELIZA_RUNNER_CONFIRM_SECS \
    ELIZA_RUNNER_PROC_ROOT ELIZA_RUNNER_KILL_CMD \
    ELIZA_RUNNER_POLL_INTERVAL; do
    if [ -n "${!override:-}" ]; then
      echo "refusing to honor ${override} without ELIZA_RUNNER_FAKE_HOST=1" >&2
      exit 78
    fi
  done
  # Belt and braces: even with the flag typo'd into existence, a real run must
  # only ever touch the documented host layout.
  [ "$runners_root" = "$default_runners_root" ] || exit 78
  [ "$unit_dst" = "$default_unit_dst" ] || exit 78
fi

install_root="${runners_root}/runner-${slot}"
pages_dir="${install_root}/_diag/pages"
canonical_unit_src="$(cd "$(dirname "$0")" && pwd)/actions-runner@.service"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -d "$install_root" ] || { echo "missing install root: $install_root" >&2; exit 1; }
[ -f "$canonical_unit_src" ] || { echo "missing canonical unit next to this script" >&2; exit 1; }

run() {
  if $apply; then
    echo "+ $*"
    "$@"
  else
    echo "DRY-RUN: $*"
  fi
}

proc_cwd() {
  # `cd` resolves both a real /proc/<pid>/cwd link and the harness's symlink
  # without depending on GNU-only `readlink -f`.
  (cd "${proc_root}/${1}/cwd" 2>/dev/null && pwd -P) || true
}

slot_pids() {
  # Every runner process whose cwd resolves inside this slot's install root.
  local pid cwd
  for pid in $(pgrep -f 'Runner\.(Listener|Worker)|runsvc\.sh' || true); do
    cwd="$(proc_cwd "$pid")"
    case "$cwd" in
      "$install_root" | "$install_root"/*) echo "$pid" ;;
    esac
  done
}

listener_pids() {
  local pid
  slot_pids | while read -r pid; do
    if grep -q 'Runner\.Listener' "${proc_root}/${pid}/cmdline" 2>/dev/null; then
      echo "$pid"
    fi
  done
  return 0
}

echo "== slot ${slot}: pre-repair state =="
systemctl --no-pager status "$unit" || true
pre_pids="$(slot_pids | tr '\n' ' ')"
echo "slot-owned runner processes: ${pre_pids:-none}"

echo "== stop unit and reap abandoned listener chains =="
run systemctl stop "$unit"
if $apply; then
  for pid in $(slot_pids); do
    echo "+ kill -TERM ${pid} (abandoned by KillMode=process)"
    "$kill_cmd" -TERM "$pid" || true
  done
  for _ in $(seq 1 "$settle_secs"); do
    [ -z "$(slot_pids)" ] && break
    sleep "$poll_interval"
  done
  leftover="$(slot_pids | tr '\n' ' ')"
  [ -z "$leftover" ] || { echo "processes still alive after TERM: ${leftover}" >&2; exit 1; }
else
  echo "DRY-RUN: would TERM and await: ${pre_pids:-none}"
fi

echo "== preserve colliding diagnostic pages =="
if [ -e "$pages_dir" ]; then
  run mv "$pages_dir" "${install_root}/_diag/pages.issue-19708-${stamp}"
else
  echo "no ${pages_dir} present"
fi
run install -d -o github-runner -g github-runner -m 0755 "${install_root}/_diag" "$pages_dir"

echo "== install canonical template unit =="
# Compare the COMPLETE normalized unit, not just the stop policy: a host can
# carry a stale fragment that already says KillMode=control-group while its
# User, WorkingDirectory, or ExecStart still point at the wrong slot layout.
normalize_unit() {
  sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$1"
}
if [ -f "$unit_dst" ] && \
   [ "$(normalize_unit "$unit_dst")" = "$(normalize_unit "$canonical_unit_src")" ]; then
  echo "installed unit already matches the canonical template"
else
  if [ -f "$unit_dst" ]; then
    echo "installed unit differs from the canonical template; replacing"
    diff -u <(normalize_unit "$unit_dst") <(normalize_unit "$canonical_unit_src") || true
    run cp "$unit_dst" "${unit_dst}.issue-19708-${stamp}.bak"
  fi
  run install -o root -g root -m 0644 "$canonical_unit_src" "$unit_dst"
  run systemctl daemon-reload
fi

echo "== restart only this slot and verify single ownership =="
run systemctl start "$unit"
if $apply; then
  # Poll rather than assume a fixed startup latency: a slow listener boot must
  # not be reported as a failed repair.
  listeners=""
  for _ in $(seq 1 "$settle_secs"); do
    sleep "$poll_interval"
    listeners="$(listener_pids | tr '\n' ' ')"
    [ -n "${listeners// /}" ] && break
  done
  count="$(echo "$listeners" | wc -w | tr -d ' ')"
  # The #19708 shape is a SECOND listener that surfaces a few seconds after the
  # first, so the first non-empty sample proves nothing. Keep sampling for a
  # fixed confirm window and judge the worst count seen in it.
  for _ in $(seq 1 "$confirm_secs"); do
    sleep "$poll_interval"
    sample="$(listener_pids | tr '\n' ' ')"
    sample_count="$(echo "$sample" | wc -w | tr -d ' ')"
    if [ "$sample_count" -gt "$count" ]; then
      count="$sample_count"
      listeners="$sample"
    fi
  done
  echo "post-repair Runner.Listener pids: ${listeners:-none} (count=${count})"
  [ "$count" -eq 1 ] || { echo "expected exactly one listener for slot ${slot}" >&2; exit 1; }
  systemctl --no-pager status "$unit"
  echo "slot ${slot} repaired; run two verification jobs before restoring the hetzner-robot label"
else
  echo "DRY-RUN complete; re-run with --apply to mutate"
fi
