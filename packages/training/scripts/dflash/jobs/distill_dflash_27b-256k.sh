#!/usr/bin/env bash
# Target catalog tier: eliza-1-27b-256k (see packages/shared/src/local-inference/catalog.ts)
# Distill the DFlash drafter for Eliza-1 tier 27b-256k.
#
# Student base: Qwen/Qwen3.5-0.8B-Base. Acceptance gate: 0.52.
#
# Hardware (starting-point — tune empirically):
#   Use 2x H200/H100 class GPUs. The drafter still trains at short KD windows;
#   long-context validation is handled by the release eval harness.

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
