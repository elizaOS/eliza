#!/usr/bin/env bash
# Canonical backstop watcher for Nebius H200 SFT runs launched via
# train_nebius.sh full. Codified from the v4b watcher that rescued the
# 2026-05-13 0.8B SFT after the original watcher's nebius-CLI auth-check
# false-positive teardown (incident: .swarm/STATUS.md, 2026-05-12 22:28Z).
#
# Design (corrects the v4 watcher bug):
#   - SSH liveness is the AUTHORITATIVE billing-stop signal. SSH-auth survives
#     nebius CLI federation token expiry. nebius CLI calls are CONFIRMATION
#     only — never the sole "instance gone" signal.
#   - 3 consecutive SSH failures => declare VM dead. Single blips don't trip.
#   - Sentinel match (`^RUN_PIPELINE_EXIT=[0-9]`) is line-anchored, NOT
#     substring (post-mortem of 2026-05-11/12 false positives).
#   - On deadline / driver-death: Ctrl-C the remote tmux session BEFORE
#     fetch+teardown, so the training compute stops even if nebius teardown
#     fails on expired auth.
#
# Required env / args:
#   NEBIUS_PROJECT_ID            (export, e.g. project-e00kfz6cpr00q21z892vec)
#   NEBIUS_VM_NAME               (export, e.g. eliza-train-h200-0_8b-v5)
#   RUN_NAME                     (export, e.g. eliza-1-0_8b-apollo-...-v5-1234)
#   VM_IP                        (export OR auto-derive via vm_ip())
#   $1 = FULL_PID                 (PID of `bash train_nebius.sh full`)
#   $2 = DEADLINE_HOURS           (optional, default 12 to match the runner cap)
#   $3 = LOG                      (optional, default /tmp/nebius-watcher-<RUN_NAME>.log)
#
# Multi-tier mode (for train_nebius_smoke_all_tiers.sh):
#   WATCHER_MULTI_TIER_TAG       when set, the watcher polls the orchestrator's
#                                  own local log for a "MULTI_TIER_DONE" line
#                                  (emitted by train_nebius_smoke_all_tiers.sh
#                                  after every tier has been attempted) instead
#                                  of the per-run remote sentinel. RUN_NAME and
#                                  the remote-log poll are unused in this mode.
#                                  The teardown call still goes through
#                                  train_nebius.sh teardown so VM + boot disk
#                                  are deleted in the canonical order.
#   WATCHER_MULTI_TIER_LOG       path to that orchestrator log (default
#                                  /tmp/smoke-all-${WATCHER_MULTI_TIER_TAG}.log).
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.nebius/bin:$PATH"

: "${NEBIUS_PROJECT_ID:?must export NEBIUS_PROJECT_ID}"
: "${NEBIUS_VM_NAME:?must export NEBIUS_VM_NAME}"
# In multi-tier mode RUN_NAME is unused (no single-run remote log to poll).
if [ -z "${WATCHER_MULTI_TIER_TAG:-}" ]; then
  : "${RUN_NAME:?must export RUN_NAME (or set WATCHER_MULTI_TIER_TAG for multi-tier mode)}"
fi

FULL_PID="${1:-}"
DEADLINE_HOURS="${2:-12}"
if [ -n "${WATCHER_MULTI_TIER_TAG:-}" ]; then
  LOG="${3:-/tmp/nebius-watcher-multi-${WATCHER_MULTI_TIER_TAG}.log}"
  MULTI_TIER_LOG="${WATCHER_MULTI_TIER_LOG:-/tmp/smoke-all-${WATCHER_MULTI_TIER_TAG}.log}"
  REMOTE_LOG=""
else
  LOG="${3:-/tmp/nebius-watcher-${RUN_NAME}.log}"
  MULTI_TIER_LOG=""
  REMOTE_LOG="/opt/training/run_${RUN_NAME}.log"
fi
DEADLINE=$(( $(date +%s) + DEADLINE_HOURS*3600 ))

vm_ip() {
  if [ -n "${VM_IP:-}" ]; then echo "$VM_IP"; return 0; fi
  nebius compute v1 instance list --parent-id "$NEBIUS_PROJECT_ID" --format json 2>/dev/null \
    | python3 -c "import sys,json,os
d=json.load(sys.stdin) or {}
n=os.environ['NEBIUS_VM_NAME']
for it in d.get('items',[]):
  if it.get('metadata',{}).get('name')==n:
    nics=it.get('status',{}).get('networkInterfaces',[])
    for x in nics:
      pip=x.get('publicIpAddress',{}).get('address','')
      if pip: print(pip.split('/')[0]); break
    break" 2>/dev/null
}

# Resolve VM IP at arm time. If nebius CLI is dead, the caller must set VM_IP.
RESOLVED_IP="$(vm_ip)"
if [ -z "$RESOLVED_IP" ]; then
  echo "[watcher $(date -u +%FT%TZ)] WARN: could not resolve VM IP via nebius CLI; set VM_IP env explicitly before launching watcher" | tee -a "$LOG"
  exit 2
fi
echo "[watcher $(date -u +%FT%TZ)] armed: RUN_NAME=${RUN_NAME:-<multi-tier:${WATCHER_MULTI_TIER_TAG:-}>} VM=$NEBIUS_VM_NAME IP=$RESOLVED_IP FULL_PID=$FULL_PID deadline=$(date -u -d @$DEADLINE +%FT%TZ) ${DEADLINE_HOURS}h" >> "$LOG"

ssh_alive() {
  # AUTHORITATIVE VM liveness: SSH-auth survives nebius CLI expiry.
  timeout 20 ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
    "ubuntu@$RESOLVED_IP" "true" 2>/dev/null
}
full_alive() {
  [ -n "$FULL_PID" ] && kill -0 "$FULL_PID" 2>/dev/null && return 0
  pgrep -f "train_nebius.sh full" >/dev/null 2>&1
}
sentinel_done() {
  # Line-anchored — substring matches caused the 2026-05-11/12 false positives.
  if [ -n "$MULTI_TIER_LOG" ]; then
    # Multi-tier mode: orchestrator emits "MULTI_TIER_DONE" to its own local log
    # after every tier has been attempted (success or fail). Scan the local log
    # rather than a single remote per-run log.
    [ -f "$MULTI_TIER_LOG" ] && grep -qE '^\[smoke-all\] MULTI_TIER_DONE' "$MULTI_TIER_LOG"
  else
    timeout 15 ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
      "ubuntu@$RESOLVED_IP" "grep -qE '^RUN_PIPELINE_EXIT=[0-9]' $REMOTE_LOG 2>/dev/null"
  fi
}
stop_remote_training() {
  echo "[watcher $(date -u +%FT%TZ)] Ctrl-C any remote training tmux sessions to stop GPU compute" >> "$LOG"
  # Single-run mode uses session 'elizatrain'. Multi-tier mode opens one
  # session per tier named 'elizasmoke_<tier>'. Send C-c to every matching
  # session; the unmatched ones just no-op.
  timeout 60 ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "ubuntu@$RESOLVED_IP" \
    "for s in \$(tmux ls 2>/dev/null | awk -F: '/^(elizatrain|elizasmoke_)/{print \$1}'); do tmux send-keys -t \"\$s\" C-c 2>/dev/null || true; done" \
    >> "$LOG" 2>&1 || true
}
fetch_and_teardown() {
  bash scripts/train_nebius.sh fetch >> "$LOG" 2>&1 || echo "[watcher] fetch failed (network/ssh)" >> "$LOG"
  if [ -n "${RUN_NAME:-}" ] && [ -f "checkpoints/$RUN_NAME/gate_report.json" ]; then
    echo "[watcher] gate_report.json contents:" >> "$LOG"
    cat "checkpoints/$RUN_NAME/gate_report.json" >> "$LOG"
  fi
  bash scripts/train_nebius.sh teardown >> "$LOG" 2>&1 \
    || echo "[watcher $(date -u +%FT%TZ)] TEARDOWN FAILED (likely nebius CLI auth expired) — VM STILL UP, billing continues. Manual teardown required." >> "$LOG"
}

SSH_FAIL_COUNT=0

while true; do
  sleep 120
  now=$(date +%s)

  if ssh_alive; then
    SSH_FAIL_COUNT=0
    VM_STATE="up"
  else
    SSH_FAIL_COUNT=$((SSH_FAIL_COUNT + 1))
    VM_STATE="ssh_fail_${SSH_FAIL_COUNT}"
  fi

  if [ "$now" -ge "$DEADLINE" ]; then
    echo "[watcher $(date -u +%FT%TZ)] ${DEADLINE_HOURS}h deadline hit, vm=$VM_STATE — fetch + teardown." >> "$LOG"
    stop_remote_training
    fetch_and_teardown
    break
  fi

  if [ $SSH_FAIL_COUNT -eq 0 ]; then
    if sentinel_done; then
      echo "[watcher $(date -u +%FT%TZ)] line-anchored RUN_PIPELINE_EXIT sentinel found — grace 120s then fetch+teardown." >> "$LOG"
      sleep 120
      fetch_and_teardown
      break
    fi
    if ! full_alive; then
      echo "[watcher $(date -u +%FT%TZ)] driver gone but VM up — fetch+teardown." >> "$LOG"
      sleep 90
      stop_remote_training
      fetch_and_teardown
      break
    fi
    continue
  fi

  if [ $SSH_FAIL_COUNT -ge 3 ]; then
    if full_alive; then
      echo "[watcher $(date -u +%FT%TZ)] 3+ consecutive SSH failures, driver still alive — sustained outage, keep polling." >> "$LOG"
    else
      echo "[watcher $(date -u +%FT%TZ)] 3+ consecutive SSH failures + driver gone — likely VM gone (full's EXIT trap cleaned up). Exiting." >> "$LOG"
      break
    fi
  fi
done

echo "[watcher $(date -u +%FT%TZ)] done." >> "$LOG"
