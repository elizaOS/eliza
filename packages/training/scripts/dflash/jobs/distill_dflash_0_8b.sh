#!/usr/bin/env bash
# Target catalog tier: eliza-1-0_8b (see packages/shared/src/local-inference/catalog.ts)
# Distill the tiny DFlash drafter for the smallest Eliza-1 tier.
#
# Student base: Qwen/Qwen3.5-0.8B-Base. Acceptance gate: 0.40.
#
# Hardware (starting point — tune empirically):
#   1× 16GB GPU should be enough for target + student bf16 at short KD context.
#   Estimated wall time: ~4-6h for ~25k samples × 2 epochs at batch 16.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="0_8b"
EPOCHS="${EPOCHS:-2}"
BATCH_SIZE="${BATCH_SIZE:-16}"
GRAD_ACCUM="${GRAD_ACCUM:-2}"
LR="${LR:-2e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-1536}"

dflash_run_distill "$@"
