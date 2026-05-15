#!/usr/bin/env bash
# Launch DFlash drafter distillation for Eliza-1 tiers on a Vast.ai GPU host.
#
# This script is intended to run inside an already-provisioned Vast instance
# after the repo and training data have been mounted. It mirrors the Nebius
# launcher but avoids any provider API dependency so dry-run validation works
# locally and inside plain containers.
#
# Usage:
#   bash launch_all_tiers.sh --dry-run
#   bash launch_all_tiers.sh --dry-run --tiers 2b,4b
#   TARGET_CHECKPOINT_ROOT=/data/checkpoints \
#   DATASET_ROOT=/data/distill-datasets \
#   TARGET_GGUF_ROOT=/data/eliza-1-final-gguf \
#   OUTPUT_ROOT=/data/dflash-out \
#   bash launch_all_tiers.sh --tiers 2b

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TRAINING_SCRIPT="${TRAINING_ROOT}/scripts/distill_dflash_drafter.py"

# Format: TIER:POLICY:EPOCHS:BATCH_SIZE:GRAD_ACCUM:LR:MAX_SEQ_LEN
ALL_TIERS=(
  "0_8b:disabled:0:0:0:0:0"
  "2b:required:3:16:2:2e-4:2048"
  "4b:required:3:8:4:2e-4:2048"
  "9b:required:5:8:4:1.5e-4:2048"
  "27b:required:5:8:4:1e-4:2048"
  "27b-256k:required:5:8:4:1e-4:2048"
)

DRY_RUN=0
SELECTED_TIERS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
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
      sed -n '2,30p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

log() {
  printf '[vast-dflash] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "FATAL: $*" >&2
  exit 1
}

tier_in_selected() {
  local tier="$1"
  if [[ -z "${SELECTED_TIERS}" ]]; then
    return 0
  fi
  local IFS=','
  for selected in ${SELECTED_TIERS}; do
    if [[ "${selected// /}" == "${tier}" ]]; then
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
  if [[ -x "${HOME}/train-env/bin/python" ]]; then
    echo "${HOME}/train-env/bin/python"
  elif command -v uv >/dev/null 2>&1; then
    echo "uv run --extra train python"
  else
    echo "python3"
  fi
}

if (( ! DRY_RUN )); then
  [[ -n "${TARGET_CHECKPOINT_ROOT:-}" ]] || die "TARGET_CHECKPOINT_ROOT is unset"
  [[ -n "${DATASET_ROOT:-}" ]] || die "DATASET_ROOT is unset"
  [[ -n "${OUTPUT_ROOT:-}" ]] || die "OUTPUT_ROOT is unset"
fi

OUTPUT_ROOT="${OUTPUT_ROOT:-/tmp/dflash-out}"
TARGET_GGUF_ROOT="${TARGET_GGUF_ROOT:-/data/eliza-1-final-gguf}"
PY="$(resolve_python)"
ts_launch="$(date -u +%Y%m%dT%H%M%SZ)"
launched=0
skipped=0

for entry in "${ALL_TIERS[@]}"; do
  IFS=':' read -r TIER POLICY EPOCHS BATCH_SIZE GRAD_ACCUM LR MAX_SEQ_LEN <<< "${entry}"
  if ! tier_in_selected "${TIER}"; then
    skipped=$(( skipped + 1 ))
    continue
  fi

  out_dir="${OUTPUT_ROOT}/${TIER}-${ts_launch}"
  if [[ "${POLICY}" == "disabled" ]]; then
    cmd=(
      ${PY} "${TRAINING_SCRIPT}"
      --tier "${TIER}"
      --out-dir "${out_dir}"
    )
  else
    cmd=(
      ${PY} "${TRAINING_SCRIPT}"
      --tier "${TIER}"
      --target-checkpoint "${TARGET_CHECKPOINT_ROOT:-/data/checkpoints}/eliza-1-${TIER}"
      --target-gguf "$(text_gguf_path_for_tier "${TARGET_GGUF_ROOT}" "${TIER}")"
      --dataset "${DATASET_ROOT:-/data/distill-datasets}/eliza-1-${TIER}/distill.jsonl"
      --epochs "${EPOCHS}"
      --batch-size "${BATCH_SIZE}"
      --grad-accum "${GRAD_ACCUM}"
      --lr "${LR}"
      --max-seq-len "${MAX_SEQ_LEN}"
      --out-dir "${out_dir}"
    )
  fi

  if [[ -n "${EXTRA_TRAIN_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    cmd+=(${EXTRA_TRAIN_ARGS})
  fi

  log "tier=${TIER} policy=${POLICY} out=${out_dir}"
  log "  cmd: ${cmd[*]}"
  if (( DRY_RUN )); then
    launched=$(( launched + 1 ))
    continue
  fi

  mkdir -p "${out_dir}"
  set +e
  "${cmd[@]}" 2>&1 | tee "${out_dir}/distill.log"
  exit_code=${PIPESTATUS[0]}
  set -e
  if (( exit_code != 0 )); then
    log "FAIL tier=${TIER} exit_code=${exit_code}"
  else
    log "DONE tier=${TIER}"
  fi
  launched=$(( launched + 1 ))
done

log "Launch complete: launched=${launched} skipped=${skipped}"
if (( DRY_RUN )); then
  log "(dry-run - no commands were executed)"
fi
