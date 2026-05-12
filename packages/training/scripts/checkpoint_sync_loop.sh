#!/usr/bin/env bash
# checkpoint_sync_loop.sh — pull intermediate Vast.ai training checkpoints
# back to the local box at a fixed cadence so a UI (or operator) can plot
# progress while the run is still going.
#
# Pairs with `eval_loop.sh` (which scores each pulled checkpoint) and
# `progress_report.py` (which renders an HTML chart from `_progress.jsonl`).
#
# This script does NOT spin up Vast instances — that is owned by
# `train_vast.sh`. We only read the instance id it already provisioned
# (via `MILADY_VAST_INSTANCE_ID` / `VAST_INSTANCE_ID` env, or the
# `.vast_instance_id` file in the repo root).
#
# Args:
#   --run-name <name>            (required) — must match the RUN_NAME passed
#                                 to `train_vast.sh`. Checkpoints land under
#                                 training/checkpoints/<run-name>/ locally,
#                                 mirroring ~/training/checkpoints/<run-name>/
#                                 on the Vast box.
#   --interval-seconds <n>       default 1800 (30 min). Time between rsync
#                                 sweeps. We rely on rsync's own
#                                 incremental transfer so re-pulling an
#                                 unchanged checkpoint is cheap.
#   --max-checkpoints <n>        default 0 (keep all). When >0, after each
#                                 successful pull we delete oldest
#                                 `checkpoint-<step>` dirs locally until
#                                 only N remain. The `final/` dir is never
#                                 pruned. Disk usage is otherwise the
#                                 operator's responsibility (these dirs are
#                                 git-lfs-ignored).
#
# On SIGTERM/SIGINT we exit cleanly between sweeps (in-flight rsync gets
# the same signal and returns non-zero, which we treat as "try next sweep"
# rather than crash).
#
# Logs to ~/.milady/checkpoint-sync.log with a 10 MB rotation.

set -euo pipefail

RUN_NAME=""
INTERVAL_SECONDS=1800
MAX_CHECKPOINTS=0

usage() {
  cat <<'EOF'
Usage: checkpoint_sync_loop.sh --run-name <name> [--interval-seconds N] [--max-checkpoints N]

Polls a running Vast.ai training instance for new checkpoint-* dirs and
rsyncs them into training/checkpoints/<run-name>/. Run this in a separate
terminal (or under tmux) while train_vast.sh handles the actual training.

Required:
  --run-name <name>          Must match RUN_NAME passed to train_vast.sh.

Optional:
  --interval-seconds <n>     Sweep cadence in seconds. Default 1800 (30 min).
  --max-checkpoints <n>      Keep only the N newest checkpoint-* dirs locally
                             after each pull (0 = keep all). 'final/' is
                             never pruned. Default 0.

Env (read, never written):
  MILADY_VAST_INSTANCE_ID    Vast instance id. Set by train_vast.sh provision.
  VAST_INSTANCE_ID           Legacy alias. Honored if MILADY_* unset.

Outputs:
  training/checkpoints/<run-name>/checkpoint-<step>/...
  training/checkpoints/<run-name>/_pull-log.jsonl  (one line per successful pull)
  ~/.milady/checkpoint-sync.log                    (rotated at 10 MB)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-name)
      RUN_NAME="${2:-}"
      shift 2
      ;;
    --interval-seconds)
      INTERVAL_SECONDS="${2:-}"
      shift 2
      ;;
    --max-checkpoints)
      MAX_CHECKPOINTS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown arg $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RUN_NAME" ]]; then
  echo "error: --run-name is required" >&2
  usage >&2
  exit 2
fi

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
  echo "error: --interval-seconds must be a positive integer" >&2
  exit 2
fi

if ! [[ "$MAX_CHECKPOINTS" =~ ^[0-9]+$ ]]; then
  echo "error: --max-checkpoints must be a non-negative integer" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_CKPT_DIR="$ROOT/checkpoints/$RUN_NAME"
PULL_LOG="$LOCAL_CKPT_DIR/_pull-log.jsonl"
LOG_FILE="$HOME/.milady/checkpoint-sync.log"
LOG_MAX_BYTES=$((10 * 1024 * 1024))

mkdir -p "$LOCAL_CKPT_DIR" "$(dirname "$LOG_FILE")"

# ---------------------------------------------------------------------------
# logging — append to LOG_FILE with 10 MB rotation, also echo to stdout.
# ---------------------------------------------------------------------------
log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line="[$ts] [sync $RUN_NAME] $*"
  echo "$line"
  if [[ -f "$LOG_FILE" ]]; then
    local size
    size="$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)"
    if [[ "$size" -ge "$LOG_MAX_BYTES" ]]; then
      mv -f "$LOG_FILE" "$LOG_FILE.1"
    fi
  fi
  echo "$line" >> "$LOG_FILE"
}

# Resolve instance id from env or .vast_instance_id (same precedence as
# train_vast.sh — MILADY_* preferred, VAST_* as backward-compat alias,
# file as last resort).
resolve_instance_id() {
  if [[ -n "${MILADY_VAST_INSTANCE_ID:-}" ]]; then
    echo "$MILADY_VAST_INSTANCE_ID"
    return 0
  fi
  if [[ -n "${VAST_INSTANCE_ID:-}" ]]; then
    echo "$VAST_INSTANCE_ID"
    return 0
  fi
  local id_file="$ROOT/.vast_instance_id"
  if [[ -f "$id_file" ]]; then
    cat "$id_file"
    return 0
  fi
  return 1
}

# Resolve the SSH endpoint via the existing vast helper. Prints
# "USER HOST PORT" on stdout. Returns non-zero if the helper fails (e.g.
# instance still booting).
ssh_endpoint() {
  local instance_id="$1"
  ( cd "$ROOT" && python3 -m scripts.lib.vast ssh "$instance_id" ) 2>/dev/null
}

# List remote `checkpoint-*` dirs (and `final` if present) under the run.
# Emits one dir name per line (e.g. "checkpoint-200", "final").
list_remote_checkpoints() {
  local user="$1" host="$2" port="$3"
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o BatchMode=yes -o ConnectTimeout=15 \
      -p "$port" "$user@$host" \
      "ls -1 ~/training/checkpoints/$RUN_NAME 2>/dev/null | grep -E '^(checkpoint-[0-9]+|final)$' || true"
}

# Local directory size in MB (rounded). Used for the pull-log entry.
dir_size_mb() {
  local dir="$1"
  du -sm "$dir" 2>/dev/null | awk '{print $1}'
}

# Append one JSONL pull-log entry. Step is the parsed integer step ("final"
# is recorded as -1 here; eval_checkpoint.py promotes it to max+1 at scoring
# time so the progress curve has a final point on the X axis).
append_pull_log() {
  local step="$1" dir="$2"
  local size_mb
  size_mb="$(dir_size_mb "$dir")"
  local pulled_at
  pulled_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"step": %s, "pulled_at": "%s", "size_mb": %s}\n' \
    "$step" "$pulled_at" "${size_mb:-0}" >> "$PULL_LOG"
}

# Prune old checkpoint-<step> dirs when --max-checkpoints is set. Sorts by
# numeric step; never touches `final/`.
prune_old_checkpoints() {
  if [[ "$MAX_CHECKPOINTS" -le 0 ]]; then
    return 0
  fi
  local kept=0
  # Sort descending by step number, drop anything past MAX_CHECKPOINTS.
  while IFS= read -r dir; do
    [[ -z "$dir" ]] && continue
    kept=$((kept + 1))
    if [[ "$kept" -gt "$MAX_CHECKPOINTS" ]]; then
      log "prune: removing old checkpoint $dir (kept=$MAX_CHECKPOINTS)"
      rm -rf -- "$LOCAL_CKPT_DIR/$dir"
    fi
  done < <(
    ls -1 "$LOCAL_CKPT_DIR" 2>/dev/null \
      | grep -E '^checkpoint-[0-9]+$' \
      | sort -t- -k2 -n -r
  )
}

# Trap SIGTERM/SIGINT so we exit cleanly between sweeps. Inside an active
# rsync the signal will propagate and rsync will exit non-zero — we treat
# that as "this sweep failed, retry next interval" rather than crashing.
SHOULD_EXIT=0
on_signal() {
  log "received signal — will exit after current sweep"
  SHOULD_EXIT=1
}
trap on_signal TERM INT

log "start: run=$RUN_NAME interval=${INTERVAL_SECONDS}s max_checkpoints=$MAX_CHECKPOINTS local=$LOCAL_CKPT_DIR"

while true; do
  if [[ "$SHOULD_EXIT" -eq 1 ]]; then
    log "exit: signal received"
    exit 0
  fi

  instance_id=""
  if instance_id="$(resolve_instance_id)" && [[ -n "$instance_id" ]]; then
    log "sweep: instance=$instance_id"
    if endpoint="$(ssh_endpoint "$instance_id")" && [[ -n "$endpoint" ]]; then
      read -r user host port <<< "$endpoint"
      remote_list="$(list_remote_checkpoints "$user" "$host" "$port" || true)"
      if [[ -z "$remote_list" ]]; then
        log "sweep: no remote checkpoints yet"
      else
        # Compare against locally-present checkpoint dirs to skip the
        # "no new step" case (rsync would still run, but the log entry
        # would be misleading).
        while IFS= read -r remote_dir; do
          [[ -z "$remote_dir" ]] && continue
          step="-1"
          if [[ "$remote_dir" =~ ^checkpoint-([0-9]+)$ ]]; then
            step="${BASH_REMATCH[1]}"
          fi
          local_dir="$LOCAL_CKPT_DIR/$remote_dir"
          had_local=0
          [[ -d "$local_dir" ]] && had_local=1

          log "pull: $remote_dir (step=$step had_local=$had_local)"
          # rsync the dir contents. We accept partial transfers (network
          # blips) and don't bail the loop if a single dir fails.
          if rsync -avh --partial --info=stats1 \
              -e "ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30" \
              "$user@$host:training/checkpoints/$RUN_NAME/$remote_dir/" \
              "$local_dir/" >> "$LOG_FILE" 2>&1; then
            # Only append a pull-log entry when the dir is genuinely new
            # locally OR its content changed (mtime newer than the log
            # entry). Cheapest correct check: if it's new, log; otherwise
            # only log when rsync actually transferred bytes. To keep the
            # log simple and the JSONL append-only we always log on a
            # successful pull but mark whether the dir was new.
            if [[ "$had_local" -eq 0 ]]; then
              append_pull_log "$step" "$local_dir"
              log "pull: $remote_dir done (new, step=$step)"
            else
              log "pull: $remote_dir done (refresh, step=$step) — no log entry"
            fi
          else
            log "pull: $remote_dir FAILED (rsync exit non-zero, will retry next sweep)"
          fi
        done <<< "$remote_list"
        prune_old_checkpoints
      fi
    else
      log "sweep: ssh endpoint not resolvable yet (instance still booting?)"
    fi
  else
    log "sweep: no MILADY_VAST_INSTANCE_ID / VAST_INSTANCE_ID / .vast_instance_id — skipping"
  fi

  if [[ "$SHOULD_EXIT" -eq 1 ]]; then
    log "exit: signal received"
    exit 0
  fi

  # Sleep in 1-second chunks so SIGTERM lands fast.
  remaining="$INTERVAL_SECONDS"
  while [[ "$remaining" -gt 0 ]]; do
    sleep 1
    remaining=$((remaining - 1))
    if [[ "$SHOULD_EXIT" -eq 1 ]]; then
      log "exit: signal received during sleep"
      exit 0
    fi
  done
done
