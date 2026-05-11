#!/usr/bin/env bash
# Vast.ai instance liveness + budget watcher.
#
# Polls `train_vast.sh status` once per minute. After 3 consecutive failed
# polls (instance unreachable, destroyed, or status returned non-zero) it
# emits a loud warning and writes an incident log under
# ~/.milady/vast-incidents/<timestamp>.log so the operator has forensic
# state when they wake up.
#
# Also enforces the per-job budget (M9):
#   * Reads MILADY_VAST_MAX_USD as the soft cap; hard cap is 1.5× that.
#   * On each successful poll, runs `scripts.lib.vast_budget enforce`.
#     * exit 10 => soft cap crossed => emit warn alert (throttled).
#     * exit 11 => hard cap crossed => run `train_vast.sh teardown --yes`.
#       Teardown is permanent; the watcher exits afterwards so the
#       operator can investigate (and so a flaky API doesn't loop us
#       into re-teardown attempts on a dead handle).
#
# This watcher does NOT auto-reprovision. Spinning up a fresh
# instance is a money decision; we only alert and (on hard cap) destroy.
#
# Usage:
#   bash training/scripts/vast-watcher.sh &        # background after provision
#   MILADY_VAST_WATCH_INTERVAL_S=60 bash ...       # override poll cadence
#   MILADY_VAST_WATCH_FAIL_THRESHOLD=3 bash ...    # override consecutive failures
#   MILADY_VAST_MAX_USD=50  bash ...               # per-job soft cap (USD)
#   MILADY_VAST_BUDGET_DRY_RUN=1 bash ...          # skip the actual teardown
#                                                  # call on hard cap; only log.
#                                                  # Used by tests and operators
#                                                  # who want a final manual ack.
#
# Logs to ~/.milady/vast-watcher.log (rotated at 10 MB).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRAIN_VAST="$ROOT/scripts/train_vast.sh"

if [ ! -x "$TRAIN_VAST" ] && [ ! -f "$TRAIN_VAST" ]; then
  echo "[vast-watcher] ERROR: $TRAIN_VAST not found" >&2
  exit 2
fi

INTERVAL_S="${MILADY_VAST_WATCH_INTERVAL_S:-60}"
FAIL_THRESHOLD="${MILADY_VAST_WATCH_FAIL_THRESHOLD:-3}"
LOG_DIR="${MILADY_STATE_DIR:-$HOME/.milady}"
LOG_FILE="$LOG_DIR/vast-watcher.log"
INCIDENT_DIR="$LOG_DIR/vast-incidents"
LOG_ROTATE_BYTES=$((10 * 1024 * 1024))

mkdir -p "$LOG_DIR" "$INCIDENT_DIR"

log() {
  local ts msg
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  msg="[vast-watcher] $ts $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

rotate_log_if_big() {
  if [ -f "$LOG_FILE" ]; then
    local sz
    sz="$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)"
    if [ "$sz" -ge "$LOG_ROTATE_BYTES" ]; then
      mv "$LOG_FILE" "$LOG_FILE.1"
      : > "$LOG_FILE"
    fi
  fi
}

alert() {
  local subject="$1"
  local body="$2"
  echo "============================================================" >&2
  echo "[vast-watcher] ALERT: $subject" >&2
  echo "$body" >&2
  echo "============================================================" >&2
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "Vast watcher: $subject" "$body" || true
  fi
}

write_incident() {
  local subject="$1"
  local body="$2"
  local ts file
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$INCIDENT_DIR/$ts.log"
  {
    echo "incident_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "subject=$subject"
    echo "consecutive_failures=$FAIL_THRESHOLD"
    echo "interval_s=$INTERVAL_S"
    echo "vast_instance_id=${VAST_INSTANCE_ID:-}"
    echo "milady_vast_instance_id=${MILADY_VAST_INSTANCE_ID:-}"
    echo
    echo "----- last status output -----"
    echo "$body"
    echo "----- recent watcher log -----"
    tail -n 100 "$LOG_FILE" 2>/dev/null || true
  } > "$file"
  log "wrote incident report $file"
}

log "starting (interval=${INTERVAL_S}s, fail_threshold=$FAIL_THRESHOLD, log=$LOG_FILE)"
if [ -n "${MILADY_VAST_MAX_USD:-}" ]; then
  log "budget enforcement: soft_cap=\$${MILADY_VAST_MAX_USD} (hard=1.5x)"
else
  log "budget enforcement: disabled (set MILADY_VAST_MAX_USD to enable)"
fi

# Returns the instance id the watcher should attribute budget to. Prefers
# the script-level env (so operators can pin it explicitly), then
# .vast_instance_id, then nothing (skip budget). Pure read — never writes.
current_instance_id() {
  if [ -n "${MILADY_VAST_INSTANCE_ID:-}" ]; then
    echo "$MILADY_VAST_INSTANCE_ID"
    return 0
  fi
  if [ -n "${VAST_INSTANCE_ID:-}" ]; then
    echo "$VAST_INSTANCE_ID"
    return 0
  fi
  if [ -f "$ROOT/.vast_instance_id" ]; then
    cat "$ROOT/.vast_instance_id"
    return 0
  fi
  return 1
}

# Run a single budget enforcement pass. Side effects:
#   - emits a soft-cap warning + incident log entry (throttled)
#   - on hard cap, calls `train_vast.sh teardown --yes` and exits the
#     watcher so we don't loop on the now-dead handle.
budget_pass() {
  if [ -z "${MILADY_VAST_MAX_USD:-}" ]; then
    return 0
  fi
  local iid
  if ! iid="$(current_instance_id)"; then
    return 0
  fi
  if [ -z "$iid" ]; then
    return 0
  fi
  local enf_out enf_rc
  enf_out="$( cd "$ROOT" && \
    REGISTRY_KEY="${REGISTRY_KEY:-}" RUN_NAME="${RUN_NAME:-}" \
    python3 -m scripts.lib.vast_budget enforce "$iid" 2>&1 )"
  enf_rc=$?
  case "$enf_rc" in
    0)
      # Under cap — log only every 10th success via _budget_ok_counter.
      if [ -z "${_budget_ok_counter:-}" ]; then _budget_ok_counter=0; fi
      _budget_ok_counter=$((_budget_ok_counter + 1))
      if [ "$((_budget_ok_counter % 10))" -eq 0 ]; then
        log "budget ok: $enf_out"
      fi
      ;;
    10)
      local now
      now="$(date +%s)"
      if [ -z "${_last_budget_alert_at:-}" ]; then _last_budget_alert_at=0; fi
      # Throttle soft-cap alerts to once per 15 min so a slow-burn
      # overshoot doesn't spam.
      if [ "$((now - _last_budget_alert_at))" -ge 900 ]; then
        alert "Vast soft budget cap exceeded" "$enf_out"
        write_incident "soft_cap_breach" "$enf_out"
        _last_budget_alert_at="$now"
      else
        log "budget over soft (throttled): $enf_out"
      fi
      ;;
    11)
      alert "Vast HARD budget cap exceeded — auto-teardown initiated" "$enf_out"
      write_incident "hard_cap_breach" "$enf_out"
      if [ "${MILADY_VAST_BUDGET_DRY_RUN:-0}" = "1" ]; then
        log "MILADY_VAST_BUDGET_DRY_RUN=1 — skipping actual teardown"
      else
        log "destroying instance $iid via train_vast.sh teardown --yes"
        if bash "$TRAIN_VAST" teardown --yes >>"$LOG_FILE" 2>&1; then
          log "teardown succeeded; exiting watcher"
        else
          log "teardown FAILED — manual intervention required"
        fi
      fi
      # Exit either way: dry-run mode wants the operator to see the
      # alert and decide; real-run mode just destroyed the handle.
      exit 0
      ;;
    *)
      log "budget enforce error rc=$enf_rc: $enf_out"
      ;;
  esac
}

consecutive_failures=0
last_alert_at=0

while true; do
  rotate_log_if_big

  # Capture both stdout+stderr so the incident log has the full picture.
  status_out="$(bash "$TRAIN_VAST" status 2>&1)"
  status_rc=$?

  if [ "$status_rc" -ne 0 ]; then
    consecutive_failures=$((consecutive_failures + 1))
    log "status nonzero rc=$status_rc consecutive=$consecutive_failures"
    log "  $(echo "$status_out" | tr '\n' ' ' | cut -c1-300)"
    if [ "$consecutive_failures" -ge "$FAIL_THRESHOLD" ]; then
      now="$(date +%s)"
      # Throttle alerts to once per 30 min so a permanently-dead instance
      # doesn't paper the desktop with notifications.
      if [ "$((now - last_alert_at))" -ge 1800 ]; then
        alert "Vast instance unreachable for $consecutive_failures consecutive polls" \
              "$status_out"
        write_incident "instance_unreachable" "$status_out"
        last_alert_at="$now"
      fi
    fi
  else
    if [ "$consecutive_failures" -gt 0 ]; then
      log "recovered after $consecutive_failures failed polls"
    fi
    consecutive_failures=0
    # Only log every Nth successful poll to keep the log readable. Default:
    # log every 10th success.
    if [ -z "${_success_counter:-}" ]; then _success_counter=0; fi
    _success_counter=$((_success_counter + 1))
    if [ "$((_success_counter % 10))" -eq 0 ]; then
      log "ok ($_success_counter consecutive successful polls)"
    fi
    # Budget enforcement only runs on a reachable instance; the alive
    # check inside `train_vast.sh status` already confirmed that.
    budget_pass
  fi

  sleep "$INTERVAL_S"
done
