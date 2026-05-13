#!/usr/bin/env bash
# Target catalog tier: all tiers (see packages/shared/src/local-inference/catalog.ts)
# This library is sourced by each per-tier distill_dflash_<tier>.sh wrapper.
# Tier → catalog mapping:
#   0_8b.sh    → eliza-1-0_8b
#   2b.sh      → eliza-1-2b
#   4b.sh      → eliza-1-4b
# Hidden placeholder wrappers for larger tiers must fail closed until those
# tiers are reintroduced with final base weights, drafters, evals, licenses,
# and platform evidence.
# Shared helpers for DFlash drafter distillation job scripts.
#
# Per-tier scripts source this file, set TIER + hyperparam env vars, and call
# `dflash_run_distill`. The shared code:
#   - locates the training package root,
#   - validates required inputs exist (target GGUF, target HF checkpoint, dataset),
#   - resolves the uv invocation (uv vs. plain python3),
#   - timestamps a runs/<tier>-<ts>/ directory under the training package,
#   - tees logs to runs/<tier>-<ts>/distill.log,
#   - exits non-zero on any missing input so the job dies fast.
#
# All of these scripts also honor `--synthetic-smoke`: that flag bypasses the
# input validation and runs the synthetic GGUF metadata-write path so CI can
# exercise the wiring without weights.

set -euo pipefail

# Resolve packages/training root (this file lives at scripts/dflash/jobs/_lib.sh).
DFLASH_TRAINING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DFLASH_REPO_ROOT="$(cd "${DFLASH_TRAINING_ROOT}/../.." && pwd)"

dflash_log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${TIER:-?}" "$*"
}

dflash_die() {
  dflash_log "FATAL: $*" >&2
  exit 1
}

dflash_resolve_python() {
  # Prefer uv if available; the training package's pyproject.toml pins all the
  # deps we need behind --extra train (torch, transformers, apollo-torch,
  # gguf). Fall back to plain python3 only when uv is missing (e.g. CI without
  # uv installed yet).
  #
  # The smoke variant (DFLASH_SMOKE=1, set by --synthetic-smoke) skips the
  # `train` extra and pulls only `gguf` + `numpy` so the pipeline can be
  # exercised on macOS where the `train` extra fails to resolve (triton has
  # no darwin wheel).
  if command -v uv >/dev/null 2>&1; then
    if [[ "${DFLASH_SMOKE:-0}" == "1" ]]; then
      echo "uv run --with gguf --with numpy python"
    else
      echo "uv run --extra train python"
    fi
  else
    echo "python3"
  fi
}

dflash_validate_inputs() {
  local missing=0
  if [[ -z "${TARGET_CHECKPOINT:-}" ]]; then
    dflash_log "TARGET_CHECKPOINT is unset (HF dir of the fine-tuned text model)"
    missing=1
  elif [[ ! -d "${TARGET_CHECKPOINT}" ]]; then
    dflash_log "TARGET_CHECKPOINT=${TARGET_CHECKPOINT} does not exist or is not a dir"
    missing=1
  fi
  if [[ -z "${TARGET_GGUF:-}" ]]; then
    dflash_log "TARGET_GGUF is unset (final shipped text GGUF for the tier)"
    missing=1
  elif [[ ! -f "${TARGET_GGUF}" ]]; then
    dflash_log "TARGET_GGUF=${TARGET_GGUF} does not exist"
    missing=1
  fi
  if [[ -z "${DATASET:-}" ]]; then
    dflash_log "DATASET is unset (jsonl built by prepare_distill_dataset.py)"
    missing=1
  elif [[ ! -f "${DATASET}" ]]; then
    dflash_log "DATASET=${DATASET} does not exist"
    missing=1
  fi
  if (( missing )); then
    dflash_die "missing required inputs; see env vars above"
  fi
}

dflash_run_distill() {
  : "${TIER:?TIER must be set by the per-tier wrapper}"
  : "${EPOCHS:?EPOCHS must be set by the per-tier wrapper}"
  : "${BATCH_SIZE:?BATCH_SIZE must be set by the per-tier wrapper}"
  : "${GRAD_ACCUM:?GRAD_ACCUM must be set by the per-tier wrapper}"
  : "${LR:?LR must be set by the per-tier wrapper}"
  : "${MAX_SEQ_LEN:?MAX_SEQ_LEN must be set by the per-tier wrapper}"

  local synthetic=0
  for arg in "$@"; do
    case "$arg" in
      --synthetic-smoke) synthetic=1 ;;
      -h|--help)
        cat <<EOF
DFlash drafter distillation job (tier=${TIER})

Required env vars (real run):
  TARGET_CHECKPOINT   HF dir of the fine-tuned Eliza-1 text model
  TARGET_GGUF         Final shipped text GGUF for this tier
  DATASET             jsonl from scripts/dflash/prepare_distill_dataset.py

Optional env vars:
  OUT_DIR             Output dir (default: <repo>/packages/training/runs/<tier>-<ts>)
  STUDENT_BASE        Override the default student base from distill_dflash_drafter.py
  OPTIMIZER           apollo|apollo_mini (default apollo_mini)
  EXTRA_ARGS          Passed through to distill_dflash_drafter.py

Flags:
  --synthetic-smoke   Skip input validation; run the pipeline smoke path

Hyperparameters baked into this script (tune empirically — these are
starting points, not gospel):
  EPOCHS=${EPOCHS}
  BATCH_SIZE=${BATCH_SIZE}
  GRAD_ACCUM=${GRAD_ACCUM}
  LR=${LR}
  MAX_SEQ_LEN=${MAX_SEQ_LEN}
EOF
        exit 0
        ;;
    esac
  done

  if (( synthetic )); then
    export DFLASH_SMOKE=1
  fi
  local py
  py="$(dflash_resolve_python)"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local out_dir="${OUT_DIR:-${DFLASH_TRAINING_ROOT}/runs/${TIER}-${ts}}"
  mkdir -p "${out_dir}"
  local log_file="${out_dir}/distill.log"

  if (( synthetic )); then
    dflash_log "running synthetic smoke for tier=${TIER} -> ${out_dir}"
    # shellcheck disable=SC2086
    ${py} "${DFLASH_TRAINING_ROOT}/scripts/distill_dflash_drafter.py" \
      --tier "${TIER}" \
      --synthetic-smoke \
      --out-dir "${out_dir}" \
      2>&1 | tee "${log_file}"
    dflash_log "synthetic smoke complete: ${out_dir}"
    return 0
  fi

  dflash_validate_inputs

  local extra_args=()
  if [[ -n "${STUDENT_BASE:-}" ]]; then
    extra_args+=(--student-base "${STUDENT_BASE}")
  fi
  if [[ -n "${OPTIMIZER:-}" ]]; then
    extra_args+=(--optimizer "${OPTIMIZER}")
  fi
  if [[ -n "${EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    extra_args+=(${EXTRA_ARGS})
  fi

  dflash_log "starting real distill for tier=${TIER} -> ${out_dir}"
  dflash_log "  target_checkpoint=${TARGET_CHECKPOINT}"
  dflash_log "  target_gguf=${TARGET_GGUF}"
  dflash_log "  dataset=${DATASET}"
  dflash_log "  hyperparams: epochs=${EPOCHS} batch_size=${BATCH_SIZE} grad_accum=${GRAD_ACCUM} lr=${LR} max_seq_len=${MAX_SEQ_LEN}"

  # shellcheck disable=SC2086
  ${py} "${DFLASH_TRAINING_ROOT}/scripts/distill_dflash_drafter.py" \
    --tier "${TIER}" \
    --target-checkpoint "${TARGET_CHECKPOINT}" \
    --target-gguf "${TARGET_GGUF}" \
    --dataset "${DATASET}" \
    --epochs "${EPOCHS}" \
    --batch-size "${BATCH_SIZE}" \
    --grad-accum "${GRAD_ACCUM}" \
    --lr "${LR}" \
    --max-seq-len "${MAX_SEQ_LEN}" \
    --out-dir "${out_dir}" \
    "${extra_args[@]}" \
    2>&1 | tee "${log_file}"

  dflash_log "distill complete: ${out_dir}/drafter-${TIER}.gguf + drafter-${TIER}.distill.json"
  dflash_log "next: run scripts/dflash/validate_drafter.py against the new drafter + target GGUF"
}
