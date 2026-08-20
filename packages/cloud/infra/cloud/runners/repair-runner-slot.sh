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
install_root="/opt/actions-runners/runner-${slot}"
pages_dir="${install_root}/_diag/pages"
canonical_unit_src="$(cd "$(dirname "$0")" && pwd)/actions-runner@.service"
unit_dst="/etc/systemd/system/actions-runner@.service"
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
  for _ in $(seq 1 30); do
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
if [ -f "$unit_dst" ] && grep -q '^KillMode=control-group$' "$unit_dst"; then
  echo "installed unit already uses KillMode=control-group"
else
  [ -f "$unit_dst" ] && run cp "$unit_dst" "${unit_dst}.issue-19708-${stamp}.bak"
  run install -o root -g root -m 0644 "$canonical_unit_src" "$unit_dst"
  run systemctl daemon-reload
fi

echo "== restart only this slot and verify single ownership =="
run systemctl start "$unit"
if $apply; then
  sleep 5
  listeners="$(slot_pids | while read -r pid; do
    grep -lq 'Runner\.Listener' "/proc/${pid}/cmdline" 2>/dev/null && echo "$pid" || true
  done | tr '\n' ' ')"
  count="$(echo "$listeners" | wc -w | tr -d ' ')"
  echo "post-repair Runner.Listener pids: ${listeners:-none} (count=${count})"
  [ "$count" -eq 1 ] || { echo "expected exactly one listener for slot ${slot}" >&2; exit 1; }
  systemctl --no-pager status "$unit"
  echo "slot ${slot} repaired; run two verification jobs before restoring the hetzner-robot label"
else
  echo "DRY-RUN complete; re-run with --apply to mutate"
fi
