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

set -euo pipefail

usage() {
  echo "usage: $0 <slot-number> [--apply]" >&2
  exit 64
}

[ $# -ge 1 ] || usage
slot="$1"
apply=false
[ "${2:-}" = "--apply" ] && apply=true
case "$slot" in
  '' | *[!0-9]*) usage ;;
esac

unit="actions-runner@${slot}.service"
# The two host paths are overridable so the repair flow itself can be
# regression-tested against a fake systemd host. Production runs must leave
# both unset; the defaults are the real Hetzner robot-host layout.
runners_root="${ELIZA_RUNNERS_ROOT:-/opt/actions-runners}"
install_root="${runners_root}/runner-${slot}"
pages_dir="${install_root}/_diag/pages"
canonical_unit_src="$(cd "$(dirname "$0")" && pwd)/actions-runner@.service"
unit_dst="${ELIZA_RUNNER_UNIT_PATH:-/etc/systemd/system/actions-runner@.service}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# Seconds to wait for processes to exit / the new listener to appear.
settle_secs="${ELIZA_RUNNER_SETTLE_SECS:-30}"

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

slot_pids() {
  # Every process whose cwd resolves inside this slot's install root.
  local pid cwd
  for pid in $(pgrep -f 'Runner\.(Listener|Worker)|runsvc\.sh' || true); do
    cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
    case "$cwd" in
      "$install_root" | "$install_root"/*) echo "$pid" ;;
    esac
  done
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
    kill -TERM "$pid" || true
  done
  for _ in $(seq 1 "$settle_secs"); do
    [ -z "$(slot_pids)" ] && break
    sleep 1
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
    sleep 1
    listeners="$(slot_pids | while read -r pid; do
      grep -q 'Runner\.Listener' "/proc/${pid}/cmdline" 2>/dev/null && echo "$pid" || true
    done | tr '\n' ' ')"
    [ -n "${listeners// /}" ] && break
  done
  count="$(echo "$listeners" | wc -w | tr -d ' ')"
  echo "post-repair Runner.Listener pids: ${listeners:-none} (count=${count})"
  [ "$count" -eq 1 ] || { echo "expected exactly one listener for slot ${slot}" >&2; exit 1; }
  systemctl --no-pager status "$unit"
  echo "slot ${slot} repaired; run two verification jobs before restoring the hetzner-robot label"
else
  echo "DRY-RUN complete; re-run with --apply to mutate"
fi
