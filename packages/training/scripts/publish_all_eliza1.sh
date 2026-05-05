#!/usr/bin/env bash
# publish_all_eliza1.sh — orchestrate the full eliza-1 HF release matrix.
#
# Walks the (size x quant variant x lineage) matrix and dispatches each cell
# to scripts/push_model_to_hf.py. Skips any cell whose checkpoint directory
# is missing — re-run after each quantization / abliteration step lands.
#
# Layout assumed for checkpoint directories (override with --checkpoint-root):
#   <root>/eliza-1-2b/                                bf16 SFT checkpoint
#   <root>/eliza-1-2b/polarquant/                     polarquant sidecar
#   <root>/eliza-1-2b/turboquant/                     turboquant sidecar
#   <root>/eliza-1-2b/fp8/                            fp8 weights
#   <root>/eliza-1-2b/gguf-q4_k_m/  (with *.gguf)     llama.cpp K-quant
#   <root>/eliza-1-2b/gguf-q5_k_m/
#   <root>/eliza-1-2b/gguf-q6_k/
#   <root>/eliza-1-2b-uncensored/                     post-abliteration
#                                                     (with abliteration_metadata.json)
# Same scheme for eliza-1-9b and eliza-1-27b.
#
# QJL is intentionally absent from the matrix: it is a runtime-time
# KV-cache projection, not a published checkpoint.
#
# Usage:
#   scripts/publish_all_eliza1.sh                    # push everything that exists
#   scripts/publish_all_eliza1.sh --dry-run          # show what would be pushed
#   scripts/publish_all_eliza1.sh --filter-size 27b  # only the 27B matrix
#   scripts/publish_all_eliza1.sh --filter-quant polarquant
#   scripts/publish_all_eliza1.sh --filter-quant base       # only the bf16 base repo
#   scripts/publish_all_eliza1.sh --filter-variant uncensored
#   scripts/publish_all_eliza1.sh --public           # create new repos as public
#
# Env:
#   HF_TOKEN  required for actual upload (not needed for --dry-run).
#   ELIZA1_CHECKPOINT_ROOT  default for --checkpoint-root (default: ./checkpoints).
#   ELIZA1_EVAL_DIR         dir holding <repo-slug>.json eval files; if a file
#                           exists for a given push it is forwarded as
#                           --eval-results. Default: ./eval-results.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TRAINING_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Allow running with `bash scripts/publish_all_eliza1.sh ...` from training/.
cd "${TRAINING_ROOT}"

# ─── matrix definition ────────────────────────────────────────────────────
readonly SIZES=("2b" "9b" "27b")

# Quant variants for the default (safety-tuned) lineage. These are the
# values --quant accepts in push_model_to_hf.py.
readonly DEFAULT_QUANT_VARIANTS=(
  "base"          # special token: no --quant flag (bf16 base repo)
  "polarquant"
  "turboquant"
  "fp8"
  "gguf-q4_k_m"
  "gguf-q5_k_m"
  "gguf-q6_k"
)

# The uncensored lineage ships only the bf16 base for now (quants come
# later if at all). Distinct slot so --filter-variant uncensored works.
readonly UNCENSORED_VARIANTS=("base")

# ─── registry-key resolution per size ─────────────────────────────────────
size_to_registry_key() {
  local size="$1"
  case "${size}" in
    2b)  echo "qwen3.5-2b" ;;
    9b)  echo "qwen3.5-9b" ;;
    27b) echo "qwen3.6-27b" ;;
    *) echo "unknown size: ${size}" >&2; return 1 ;;
  esac
}

# ─── arg parsing ──────────────────────────────────────────────────────────
DRY_RUN=0
PUBLIC=0
FILTER_SIZE=""
FILTER_QUANT=""
FILTER_VARIANT=""
CHECKPOINT_ROOT="${ELIZA1_CHECKPOINT_ROOT:-${TRAINING_ROOT}/checkpoints}"
EVAL_DIR="${ELIZA1_EVAL_DIR:-${TRAINING_ROOT}/eval-results}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)            DRY_RUN=1; shift ;;
    --public)             PUBLIC=1; shift ;;
    --filter-size)        FILTER_SIZE="$2"; shift 2 ;;
    --filter-quant)       FILTER_QUANT="$2"; shift 2 ;;
    --filter-variant)     FILTER_VARIANT="$2"; shift 2 ;;
    --checkpoint-root)    CHECKPOINT_ROOT="$2"; shift 2 ;;
    --eval-dir)           EVAL_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "unknown arg: $1" >&2
      echo "usage: $0 [--dry-run] [--public] [--filter-size <2b|9b|27b>] [--filter-quant <name>] [--filter-variant <default|uncensored>] [--checkpoint-root DIR] [--eval-dir DIR]" >&2
      exit 2 ;;
  esac
done

# ─── helpers ─────────────────────────────────────────────────────────────
PYTHON_BIN="${PYTHON_BIN:-python3}"
if command -v uv >/dev/null 2>&1 && [[ -f "${TRAINING_ROOT}/pyproject.toml" ]]; then
  RUNNER=(uv run python)
else
  RUNNER=("${PYTHON_BIN}")
fi

declare -i N_TOTAL=0 N_PUSHED=0 N_SKIPPED=0 N_FAILED=0
RESULTS=()

push_one() {
  local size="$1" quant_label="$2" variant="$3"
  local registry_key
  registry_key="$(size_to_registry_key "${size}")"

  # Resolve checkpoint dir.
  local ckpt
  if [[ "${variant}" == "uncensored" ]]; then
    ckpt="${CHECKPOINT_ROOT}/eliza-1-${size}-uncensored"
    [[ "${quant_label}" == "base" ]] || ckpt="${ckpt}/${quant_label}"
  else
    ckpt="${CHECKPOINT_ROOT}/eliza-1-${size}"
    [[ "${quant_label}" == "base" ]] || ckpt="${ckpt}/${quant_label}"
  fi

  # Compute the destination slug for logging + eval-results lookup.
  local repo_slug="eliza-1-${size}"
  [[ "${variant}" == "uncensored" ]] && repo_slug="${repo_slug}-uncensored"
  [[ "${quant_label}" != "base" ]] && repo_slug="${repo_slug}-${quant_label}"

  N_TOTAL+=1

  if [[ ! -d "${ckpt}" ]]; then
    echo "[skip] ${repo_slug}: checkpoint dir missing (${ckpt})"
    RESULTS+=("SKIP  ${repo_slug}  (no checkpoint)")
    N_SKIPPED+=1
    return 0
  fi

  # Build push args.
  local -a args=(
    --registry-key "${registry_key}"
    --checkpoint "${ckpt}"
  )
  [[ "${quant_label}" != "base" ]] && args+=(--quant "${quant_label}")
  [[ "${variant}" == "uncensored" ]] && args+=(--variant abliterated)
  (( DRY_RUN == 1 )) && args+=(--dry-run)
  (( PUBLIC == 1 )) && args+=(--public)

  # Forward eval results if a sidecar JSON for this slug exists.
  local eval_json="${EVAL_DIR}/${repo_slug}.json"
  if [[ -f "${eval_json}" ]]; then
    args+=(--eval-results "${eval_json}")
  fi

  echo
  echo "==> push ${repo_slug}"
  echo "    checkpoint: ${ckpt}"
  echo "    cmd: ${RUNNER[*]} scripts/push_model_to_hf.py ${args[*]}"

  if "${RUNNER[@]}" scripts/push_model_to_hf.py "${args[@]}"; then
    RESULTS+=("OK    ${repo_slug}")
    N_PUSHED+=1
  else
    RESULTS+=("FAIL  ${repo_slug}  (exit $?)")
    N_FAILED+=1
  fi
}

# ─── matrix walk ──────────────────────────────────────────────────────────
for size in "${SIZES[@]}"; do
  if [[ -n "${FILTER_SIZE}" && "${FILTER_SIZE}" != "${size}" ]]; then
    continue
  fi

  # default lineage
  if [[ -z "${FILTER_VARIANT}" || "${FILTER_VARIANT}" == "default" ]]; then
    for q in "${DEFAULT_QUANT_VARIANTS[@]}"; do
      if [[ -n "${FILTER_QUANT}" && "${FILTER_QUANT}" != "${q}" ]]; then
        continue
      fi
      push_one "${size}" "${q}" "default"
    done
  fi

  # uncensored lineage
  if [[ -z "${FILTER_VARIANT}" || "${FILTER_VARIANT}" == "uncensored" ]]; then
    for q in "${UNCENSORED_VARIANTS[@]}"; do
      if [[ -n "${FILTER_QUANT}" && "${FILTER_QUANT}" != "${q}" ]]; then
        continue
      fi
      push_one "${size}" "${q}" "uncensored"
    done
  fi
done

echo
echo "==> publish summary"
for r in "${RESULTS[@]}"; do
  echo "    ${r}"
done
echo "==> totals: ${N_TOTAL} considered, ${N_PUSHED} pushed, ${N_SKIPPED} skipped, ${N_FAILED} failed"

if (( N_FAILED > 0 )); then
  exit 1
fi
