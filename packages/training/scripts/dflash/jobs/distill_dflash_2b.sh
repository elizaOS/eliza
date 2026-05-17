#!/usr/bin/env bash
# Target catalog tier: eliza-1-2b (see packages/shared/src/local-inference/catalog.ts)
# Distill the DFlash drafter for Eliza-1 tier 2b.
#
# Student config: dflash-drafter-0_3b-qwen3_5 (2B target → mobile headroom).
# Acceptance gate: 0.48.
#
# Hardware (starting-point — TUNE EMPIRICALLY):
#   1× H200 on Nebius. Do not train locally.
#   Estimated wall time: ~8-10h for ~50k samples × 4 epochs at batch 24.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="2b"
EPOCHS="${EPOCHS:-4}"
BATCH_SIZE="${BATCH_SIZE:-24}"
GRAD_ACCUM="${GRAD_ACCUM:-2}"
LR="${LR:-2.5e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
