#!/usr/bin/env bash
# Launch DFlash drafter distillation for required Eliza-1 tiers on Nebius H200.
#
# By default, jobs run sequentially. Use --tiers to run a subset.
#
# Usage:
#   # Dry run (print commands, no execution)
#   bash launch_all_tiers.sh --dry-run
#
#   # Synthetic smoke (no GPU, validates pipeline wiring — safe to run locally)
#   bash launch_all_tiers.sh --synthetic-smoke
#
#   # Real run, all tiers
#   TARGET_CHECKPOINT_ROOT=/data/checkpoints \
#   DATASET_ROOT=/data/distill \
#   OUTPUT_ROOT=/data/dflash-out \
#   bash launch_all_tiers.sh
#
#   # Real run, specific tiers only
#   bash launch_all_tiers.sh --tiers 2b,9b
#
# Required env vars (real run, not needed for --synthetic-smoke or --dry-run):
#   TARGET_CHECKPOINT_ROOT   Directory containing per-tier HF checkpoints:
#                              <root>/eliza-1-<tier>/  (must exist per tier)
#   DATASET_ROOT             Directory containing per-tier distill datasets:
#                              <root>/eliza-1-<tier>/distill.jsonl
#   OUTPUT_ROOT              Root output directory. Per-tier outputs land in:
#                              <root>/<tier>-<timestamp>/
#
# Optional env vars:
#   TARGET_GGUF_ROOT         Directory containing per-tier text GGUFs:
#                              <root>/eliza-1-<tier>/text/eliza-1-<tier>-32k.gguf
#                            If unset, GGUF hash stamping is skipped (training
#                            still runs; stamp manually after conversion).
#   EXTRA_TRAIN_ARGS         Extra args passed to distill_drafter_h200.py.
#
# Tier-to-hardware mapping (1 GPU unless noted):
#   0_8b  → disabled; writes no-drafter policy evidence, no GPU
#   2b  4b  9b  → 1× H200 each
#   27b  27b-256k  → 2× H200 each (target + student don't fit on 1)
#
# All 6 tiers are listed in canonical order matching the tier-ID table in
# ELIZA_1_GGUF_READINESS.md and packages/shared/src/local-inference/catalog.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DFLASH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TRAINING_SCRIPT="${SCRIPT_DIR}/distill_drafter_h200.py"

# Canonical tier list + drafter sizes. 0_8b is explicit no-drafter policy
# evidence; all other rows are required DFlash distills.
# Format: TIER:POLICY:DRAFTER_SIZE_B:EPOCHS:BATCH_SIZE:GRAD_ACCUM:LR
ALL_TIERS=(
  "0_8b:disabled:0.0:0:0:0:0"
  "2b:required:0.8:3:16:2:2e-4"
  "4b:required:0.8:3:8:4:2e-4"
  "9b:required:0.8:5:8:4:1.5e-4"
  "27b:required:0.8:5:8:4:1e-4"
  "27b-256k:required:0.8:5:8:4:1e-4"
)

# --------------------------------------------------------------------------
# Parse args
# --------------------------------------------------------------------------
DRY_RUN=0
SYNTHETIC_SMOKE=0
SELECTED_TIERS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --synthetic-smoke)
      SYNTHETIC_SMOKE=1
      shift
      ;;
    --tiers)
      SELECTED_TIERS="$2"
      shift 2
      ;;
    --tiers=*)
      SELECTED_TIERS="${1#--tiers=}"
      shift
      ;;
    -h|--help)
      sed -n '2,60p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
log() {
  printf '[launch_all_tiers] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "FATAL: $*" >&2
  exit 1
}

tier_in_selected() {
  local tier="$1"
  # If no selection, run all.
  if [[ -z "${SELECTED_TIERS}" ]]; then
    return 0
  fi
  # Check comma-separated list.
  local IFS=','
  for t in ${SELECTED_TIERS}; do
    if [[ "${t// /}" == "${tier}" ]]; then
      return 0
    fi
  done
  return 1
}

text_gguf_path_for_tier() {
  local root="$1"
  local tier="$2"
  case "${tier}" in
    0_8b|2b)
      printf '%s/eliza-1-%s/text/eliza-1-%s-32k.gguf\n' "${root}" "${tier}" "${tier}"
      ;;
    4b|9b)
      printf '%s/eliza-1-%s/text/eliza-1-%s-64k.gguf\n' "${root}" "${tier}" "${tier}"
      ;;
    27b)
      printf '%s/eliza-1-%s/text/eliza-1-%s-128k.gguf\n' "${root}" "${tier}" "${tier}"
      ;;
    27b-256k)
      printf '%s/eliza-1-%s/text/eliza-1-%s.gguf\n' "${root}" "${tier}" "${tier}"
      ;;
    *)
      die "unknown tier for target GGUF path: ${tier}"
      ;;
  esac
}

resolve_python() {
  # Prefer the training venv if present (has torch, APOLLO, flash-attn).
  if [[ -x "${HOME}/train-env/bin/python" ]]; then
    echo "${HOME}/train-env/bin/python"
  elif command -v uv >/dev/null 2>&1; then
    echo "uv run python"
  else
    echo "python3"
  fi
}

# --------------------------------------------------------------------------
# Validate real-run env vars (only when not smoke/dry)
# --------------------------------------------------------------------------
if (( ! SYNTHETIC_SMOKE && ! DRY_RUN )); then
  [[ -n "${TARGET_CHECKPOINT_ROOT:-}" ]] \
    || die "TARGET_CHECKPOINT_ROOT is unset (HF checkpoint root)"
  [[ -n "${DATASET_ROOT:-}" ]] \
    || die "DATASET_ROOT is unset (distillation dataset root)"
  [[ -n "${OUTPUT_ROOT:-}" ]] \
    || die "OUTPUT_ROOT is unset (output root)"
fi

OUTPUT_ROOT="${OUTPUT_ROOT:-/tmp/dflash-out}"
PY="$(resolve_python)"

# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------
launched=0
skipped=0
ts_launch="$(date -u +%Y%m%dT%H%M%SZ)"

for entry in "${ALL_TIERS[@]}"; do
  IFS=':' read -r TIER POLICY DRAFTER_SIZE_B EPOCHS BATCH_SIZE GRAD_ACCUM LR <<< "${entry}"

  if ! tier_in_selected "${TIER}"; then
    skipped=$(( skipped + 1 ))
    continue
  fi

  ts_tier="$(date -u +%Y%m%dT%H%M%SZ)"
  out_dir="${OUTPUT_ROOT}/${TIER}-${ts_launch}"

  # Build base command.
  cmd=(
    ${PY} "${TRAINING_SCRIPT}"
    --target-tier "${TIER}"
    --drafter-size-b "${DRAFTER_SIZE_B}"
    --output-dir "${out_dir}"
  )

  if [[ "${POLICY}" == "disabled" ]]; then
    cmd+=(--dataset-path "/dev/null")
  elif (( SYNTHETIC_SMOKE )); then
    cmd+=(--synthetic-smoke)
    cmd+=(--dataset-path "/dev/null")
  else
    dataset="${DATASET_ROOT:-/data/distill-datasets}/eliza-1-${TIER}/distill.jsonl"
    checkpoint="${TARGET_CHECKPOINT_ROOT:-/data/checkpoints}/eliza-1-${TIER}"
    cmd+=(
      --dataset-path "${dataset}"
      --target-checkpoint "${checkpoint}"
      --epochs "${EPOCHS}"
      --batch-size "${BATCH_SIZE}"
      --grad-accum "${GRAD_ACCUM}"
      --lr "${LR}"
    )
    gguf_root="${TARGET_GGUF_ROOT:-}"
    if (( DRY_RUN )) && [[ -z "${gguf_root}" ]]; then
      gguf_root="/data/eliza-1-final-gguf"
    fi
    if [[ -n "${gguf_root}" ]]; then
      gguf="$(text_gguf_path_for_tier "${gguf_root}" "${TIER}")"
      cmd+=(--target-gguf "${gguf}")
    fi
  fi

  # Append any extra args.
  if [[ -n "${EXTRA_TRAIN_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    cmd+=(${EXTRA_TRAIN_ARGS})
  fi

  # Log intent.
  if [[ "${POLICY}" != "disabled" && "${cmd[*]}" != *"--epochs"* ]]; then
    cmd+=(
      --epochs "${EPOCHS}"
      --batch-size "${BATCH_SIZE}"
      --grad-accum "${GRAD_ACCUM}"
      --lr "${LR}"
    )
  fi

  log "tier=${TIER} policy=${POLICY} drafter=${DRAFTER_SIZE_B}B out=${out_dir}"
  log "  cmd: ${cmd[*]}"

  if (( DRY_RUN )); then
    log "  [dry-run] skipping execution"
    launched=$(( launched + 1 ))
    continue
  fi

  # Create output dir and start logging.
  mkdir -p "${out_dir}"
  log_file="${out_dir}/distill.log"
  log "  log: ${log_file}"

  start_epoch="$(date +%s)"
  # Run training, tee to log file.
  set +e
  "${cmd[@]}" 2>&1 | tee "${log_file}"
  exit_code=${PIPESTATUS[0]}
  set -e

  end_epoch="$(date +%s)"
  elapsed=$(( end_epoch - start_epoch ))

  if (( exit_code != 0 )); then
    log "FAIL tier=${TIER} exit_code=${exit_code} elapsed=${elapsed}s"
    log "  See ${log_file} for details."
    # Continue to remaining tiers rather than aborting the whole run.
    # The operator can re-run failed tiers with --tiers=<tier>.
  else
    log "DONE tier=${TIER} elapsed=${elapsed}s out=${out_dir}"
  fi

  launched=$(( launched + 1 ))
done

log "Launch complete: launched=${launched} skipped=${skipped}"
if (( DRY_RUN )); then
  log "(dry-run — no commands were executed)"
fi
if (( SYNTHETIC_SMOKE )); then
  log "(synthetic-smoke — no real training was performed)"
fi
