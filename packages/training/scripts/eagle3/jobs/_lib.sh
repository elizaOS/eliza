#!/usr/bin/env bash
# Shared helpers for EAGLE3 job wrappers.
#
# The job helper runs either a deterministic synthetic smoke or a real local
# prepare -> capture -> train pass when SOURCE_JSONL and TARGET_CHECKPOINT are set.

set -euo pipefail

EAGLE3_TRAINING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

eagle3_log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${TIER:-?}" "$*"
}

eagle3_die() {
  eagle3_log "FATAL: $*" >&2
  exit 1
}

eagle3_resolve_python() {
  if command -v uv >/dev/null 2>&1; then
    echo "uv run python"
  else
    echo "python3"
  fi
}

eagle3_run_pipeline() {
  : "${TIER:?TIER must be set by the wrapper}"
  : "${SYNTHETIC_SAMPLES:?SYNTHETIC_SAMPLES must be set by the wrapper}"
  : "${EPOCHS:?EPOCHS must be set by the wrapper}"
  : "${BATCH_SIZE:?BATCH_SIZE must be set by the wrapper}"
  : "${GRAD_ACCUM:?GRAD_ACCUM must be set by the wrapper}"
  : "${LR:?LR must be set by the wrapper}"
  : "${MAX_SEQ_LEN:?MAX_SEQ_LEN must be set by the wrapper}"

  local synthetic=0
  local convert_native=0
  for arg in "$@"; do
    case "$arg" in
      --synthetic-smoke) synthetic=1 ;;
      --convert-native-gguf) convert_native=1 ;;
      -h|--help)
        cat <<EOF
EAGLE3 training job (tier=${TIER})

Flags:
  --synthetic-smoke      Run prepare -> capture -> train against CI fixtures.
  --convert-native-gguf  Run external converter command after PyTorch training.

Real runs require:
  SOURCE_JSONL=<chat/text corpus JSONL>
  TARGET_CHECKPOINT=<local HF target checkpoint directory>

Optional:
  TOKENIZER=<tokenizer path/name>
  DEVICE=cpu|mps|cuda
  TRUST_REMOTE_CODE=1
  GGUF_CONVERTER='converter --model {model} --config {config} --out {out}'
  NATIVE_GGUF_OUT=/path/to/drafter.gguf
EOF
        exit 0
        ;;
    esac
  done

  local py
  py="$(eagle3_resolve_python)"
  export PYTHONPATH="${EAGLE3_TRAINING_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local out_dir="${OUT_DIR:-${EAGLE3_TRAINING_ROOT}/runs/eagle3-${TIER}-${ts}}"
  local dataset_dir="${out_dir}/dataset"
  local features_dir="${out_dir}/features"
  local train_dir="${out_dir}/train"
  mkdir -p "${out_dir}"

  if (( synthetic )); then
    eagle3_log "running synthetic EAGLE3 smoke -> ${out_dir}"
  else
    : "${SOURCE_JSONL:?SOURCE_JSONL is required for real EAGLE3 runs}"
    : "${TARGET_CHECKPOINT:?TARGET_CHECKPOINT is required for real EAGLE3 runs}"
    eagle3_log "running real EAGLE3 local training -> ${out_dir}"
  fi

  local trust_remote=()
  if [[ "${TRUST_REMOTE_CODE:-0}" == "1" ]]; then
    trust_remote=(--trust-remote-code)
  fi
  local tokenizer_args=()
  if [[ -n "${TOKENIZER:-}" ]]; then
    tokenizer_args=(--tokenizer "${TOKENIZER}")
  fi

  if (( synthetic )); then
  # shellcheck disable=SC2086
  ${py} "${EAGLE3_TRAINING_ROOT}/scripts/eagle3/prepare_distill_dataset.py" \
    --tier "${TIER}" \
    --synthetic-smoke \
    --synthetic-samples "${SYNTHETIC_SAMPLES}" \
    --out-dir "${dataset_dir}"
  else
    # shellcheck disable=SC2086
    ${py} "${EAGLE3_TRAINING_ROOT}/scripts/eagle3/prepare_distill_dataset.py" \
      --tier "${TIER}" \
      --target-checkpoint "${TARGET_CHECKPOINT}" \
      "${tokenizer_args[@]}" \
      "${trust_remote[@]}" \
      --source-jsonl "${SOURCE_JSONL}" \
      --max-samples "${MAX_SAMPLES:-0}" \
      --out-dir "${dataset_dir}"
  fi

  if (( synthetic )); then
  # shellcheck disable=SC2086
  ${py} "${EAGLE3_TRAINING_ROOT}/scripts/eagle3/capture_features.py" \
    --tier "${TIER}" \
    --synthetic-smoke \
    --dataset "${dataset_dir}/eagle3_distill.jsonl" \
    --out-dir "${features_dir}"
  else
    # shellcheck disable=SC2086
    ${py} "${EAGLE3_TRAINING_ROOT}/scripts/eagle3/capture_features.py" \
      --tier "${TIER}" \
      --target-checkpoint "${TARGET_CHECKPOINT}" \
      "${tokenizer_args[@]}" \
      "${trust_remote[@]}" \
      --dataset "${dataset_dir}/eagle3_distill.jsonl" \
      --device "${DEVICE:-cpu}" \
      --max-seq-len "${MAX_SEQ_LEN}" \
      --max-samples "${MAX_SAMPLES:-0}" \
      --out-dir "${features_dir}"
  fi

  local convert_args=()
  if (( convert_native )); then
    : "${GGUF_CONVERTER:?GGUF_CONVERTER is required with --convert-native-gguf}"
    : "${NATIVE_GGUF_OUT:?NATIVE_GGUF_OUT is required with --convert-native-gguf}"
    convert_args=(
      --convert-native-gguf
      --gguf-converter "${GGUF_CONVERTER}"
      --native-gguf-out "${NATIVE_GGUF_OUT}"
    )
  fi
  local train_mode_args=()
  if (( synthetic )); then
    train_mode_args=(--synthetic-smoke)
  fi

  local train_cmd=(
    ${py}
    "${EAGLE3_TRAINING_ROOT}/scripts/eagle3/train_eagle3_drafter.py"
    --tier "${TIER}"
    --features-manifest "${features_dir}/features.manifest.json"
    --device "${DEVICE:-cpu}"
    --epochs "${EPOCHS}"
    --batch-size "${BATCH_SIZE}"
    --grad-accum "${GRAD_ACCUM}"
    --lr "${LR}"
    --max-seq-len "${MAX_SEQ_LEN}"
    --out-dir "${train_dir}"
  )
  if (( ${#train_mode_args[@]} )); then
    train_cmd+=("${train_mode_args[@]}")
  fi
  if (( ${#convert_args[@]} )); then
    train_cmd+=("${convert_args[@]}")
  fi
  "${train_cmd[@]}"

  eagle3_log "EAGLE3 job complete: ${out_dir}"
}
