#!/usr/bin/env bash
# Target catalog tier: eliza-1-27b-256k (see packages/shared/src/local-inference/catalog.ts)
# Distill the DFlash drafter for Eliza-1 tier 27b-256k.
#
# Student base: Qwen/Qwen3.5-0.8B. Acceptance gate: 0.52.
#
# Hardware (starting-point — TUNE EMPIRICALLY):
#   Prefer 2× H200 for target + student bf16 headroom.
#   Estimated wall time: ~72h for ~50k samples × 5 epochs at batch 8.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="27b-256k"
EPOCHS="${EPOCHS:-5}"
BATCH_SIZE="${BATCH_SIZE:-8}"
GRAD_ACCUM="${GRAD_ACCUM:-4}"
LR="${LR:-1e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
