#!/usr/bin/env bash
# Distill the DFlash drafter for Eliza-1 tier 27b (32k context).
#
# Student base: Qwen/Qwen3.5-4B. Acceptance gate: 0.55.
#
# Hardware (starting-point — TUNE EMPIRICALLY):
#   2× 80GB GPU (A100/H100). bf16 27B target shards across both; 4B student
#   stays on rank 0. Use FSDP or tensor parallel for the target.
#   Estimated wall time: ~72h for ~100k samples × 5 epochs at batch 8.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="27b"
EPOCHS="${EPOCHS:-5}"
BATCH_SIZE="${BATCH_SIZE:-8}"
GRAD_ACCUM="${GRAD_ACCUM:-4}"
LR="${LR:-1e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
