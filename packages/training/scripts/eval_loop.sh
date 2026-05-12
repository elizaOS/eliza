#!/usr/bin/env bash
# eval_loop.sh — every interval, score every checkpoint that has been
# pulled by `checkpoint_sync_loop.sh` but not yet scored, and append one
# line per scored step to `_progress.jsonl` (the file the UI plots).
#
# A checkpoint dir is "evaluated" iff it contains a sibling `_eval.json`
# file written by eval_checkpoint.py. We never re-evaluate; if you want
# to force a rescore, delete that file.
#
# Args:
#   --run-name <name>            (required) — must match RUN_NAME used by
#                                 train_vast.sh / checkpoint_sync_loop.sh.
#   --registry-key <k>           (required) — passed straight through to
#                                 eval_checkpoint.py so the result JSON
#                                 records which model line this came from.
#   --interval-seconds <n>       default 600 (10 min). Time between sweeps.
#   --val-jsonl <path>           default training/data/smoke/val.jsonl.
#   --max-examples <n>           default 50, per-bucket cap for eliza_bench.
#
# On SIGTERM/SIGINT we exit cleanly between sweeps.

set -euo pipefail

RUN_NAME=""
REGISTRY_KEY=""
INTERVAL_SECONDS=600
VAL_JSONL=""
MAX_EXAMPLES=50

usage() {
  cat <<'EOF'
Usage: eval_loop.sh --run-name <name> --registry-key <k>
                    [--interval-seconds N] [--val-jsonl PATH] [--max-examples N]

Scans training/checkpoints/<run-name>/ for any checkpoint-* dirs (and
final/) that don't yet have a sibling _eval.json, runs eval_checkpoint.py
on each, and appends the result to training/checkpoints/<run-name>/_progress.jsonl.

Required:
  --run-name <name>
  --registry-key <k>            qwen3.5-2b / qwen3.5-9b / qwen3.6-27b

Optional:
  --interval-seconds <n>        default 600 (10 min)
  --val-jsonl <path>            default training/data/smoke/val.jsonl
  --max-examples <n>            default 50 per bucket
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-name)        RUN_NAME="${2:-}"; shift 2 ;;
    --registry-key)    REGISTRY_KEY="${2:-}"; shift 2 ;;
    --interval-seconds) INTERVAL_SECONDS="${2:-}"; shift 2 ;;
    --val-jsonl)       VAL_JSONL="${2:-}"; shift 2 ;;
    --max-examples)    MAX_EXAMPLES="${2:-}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)
      echo "error: unknown arg $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RUN_NAME" || -z "$REGISTRY_KEY" ]]; then
  echo "error: --run-name and --registry-key are required" >&2
  usage >&2
  exit 2
fi

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
  echo "error: --interval-seconds must be a positive integer" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_CKPT_DIR="$ROOT/checkpoints/$RUN_NAME"
PROGRESS_LOG="$LOCAL_CKPT_DIR/_progress.jsonl"
LOG_FILE="$HOME/.eliza/checkpoint-eval.log"
LOG_MAX_BYTES=$((10 * 1024 * 1024))

if [[ -z "$VAL_JSONL" ]]; then
  VAL_JSONL="$ROOT/data/smoke/val.jsonl"
fi

mkdir -p "$LOCAL_CKPT_DIR" "$(dirname "$LOG_FILE")"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line="[$ts] [eval $RUN_NAME] $*"
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

SHOULD_EXIT=0
on_signal() {
  log "received signal — will exit after current sweep"
  SHOULD_EXIT=1
}
trap on_signal TERM INT

evaluate_one() {
  local ckpt_dir="$1"
  local marker="$ckpt_dir/_eval.json"
  if [[ -f "$marker" ]]; then
    return 0
  fi
  log "evaluate: $ckpt_dir"
  if python3 "$ROOT/scripts/eval_checkpoint.py" \
        --checkpoint "$ckpt_dir" \
        --registry-key "$REGISTRY_KEY" \
        --val-jsonl "$VAL_JSONL" \
        --max-examples "$MAX_EXAMPLES" \
        --out "$marker" >> "$LOG_FILE" 2>&1; then
    # Append the single-line result to _progress.jsonl. We re-read the
    # marker (rather than letting eval_checkpoint.py write JSONL directly)
    # so the on-disk schema stays append-only and we can verify the marker
    # is well-formed before committing it to the curve.
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$marker" >/dev/null 2>&1; then
      python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))" "$marker" \
        >> "$PROGRESS_LOG"
      log "evaluate: $ckpt_dir done"
    else
      log "evaluate: $ckpt_dir produced unparsable _eval.json — skipping append"
      rm -f "$marker"
    fi
  else
    log "evaluate: $ckpt_dir FAILED — see log for traceback"
  fi
}

log "start: run=$RUN_NAME registry=$REGISTRY_KEY interval=${INTERVAL_SECONDS}s val=$VAL_JSONL max_examples=$MAX_EXAMPLES"

while true; do
  if [[ "$SHOULD_EXIT" -eq 1 ]]; then
    log "exit: signal received"
    exit 0
  fi

  if [[ -d "$LOCAL_CKPT_DIR" ]]; then
    # Sort by step number ascending so the progress.jsonl ends up roughly
    # ordered by training step (the UI sorts on read regardless, but this
    # makes `tail -f _progress.jsonl` watchable).
    while IFS= read -r ckpt; do
      [[ -z "$ckpt" ]] && continue
      [[ "$SHOULD_EXIT" -eq 1 ]] && break
      evaluate_one "$ckpt"
    done < <(
      {
        find "$LOCAL_CKPT_DIR" -mindepth 1 -maxdepth 1 -type d -name 'checkpoint-*' \
          | awk -F'checkpoint-' '{print $2"\t"$0}' \
          | sort -n \
          | cut -f2-
        # `final/` last — eval_checkpoint.py promotes it to max+1.
        if [[ -d "$LOCAL_CKPT_DIR/final" ]]; then
          echo "$LOCAL_CKPT_DIR/final"
        fi
      }
    )
  else
    log "sweep: $LOCAL_CKPT_DIR doesn't exist yet — waiting for first pull"
  fi

  if [[ "$SHOULD_EXIT" -eq 1 ]]; then
    log "exit: signal received"
    exit 0
  fi

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
