#!/usr/bin/env bash
# Target catalog tier: eliza-1-0_8b (see packages/shared/src/local-inference/catalog.ts)
# Distill the tiny DFlash drafter for the smallest Eliza-1 tier.
#
# Student config: dflash-drafter-0_1b-qwen3_5. Acceptance gate: 0.40.
#
# Hardware (starting point — tune empirically):
#   1× H200 on Nebius. Do not train locally.
#   Estimated wall time: ~4-6h for ~25k samples × 4 epochs at batch 32.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="0_8b"
EPOCHS="${EPOCHS:-4}"
BATCH_SIZE="${BATCH_SIZE:-32}"
GRAD_ACCUM="${GRAD_ACCUM:-2}"
LR="${LR:-3e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-1536}"

dflash_run_distill "$@"
