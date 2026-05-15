#!/usr/bin/env bash
# Target catalog tier: eliza-1-9b (see packages/shared/src/local-inference/catalog.ts)
# Distill the DFlash drafter for Eliza-1 tier 9b.
#
# Student base: Qwen/Qwen3.5-0.8B-Base. Acceptance gate: 0.52.
#
# Hardware (starting-point — tune empirically):
#   Prefer 1x H100/H200/A100 80GB class so the frozen target and student fit
#   comfortably with APOLLO optimizer state and checkpointing.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="9b"
EPOCHS="${EPOCHS:-5}"
BATCH_SIZE="${BATCH_SIZE:-8}"
GRAD_ACCUM="${GRAD_ACCUM:-4}"
LR="${LR:-1.5e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
