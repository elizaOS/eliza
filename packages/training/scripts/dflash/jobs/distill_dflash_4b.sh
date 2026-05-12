#!/usr/bin/env bash
# Distill the DFlash drafter for Eliza-1 tier 4b.
#
# Student base: Qwen/Qwen3.5-0.8B. Acceptance gate: 0.52.
#
# Hardware (starting-point — TUNE EMPIRICALLY):
#   1× 24GB GPU is borderline (target inference in bf16 with 4B params).
#   Prefer 1× 48GB (A6000) or 1× 80GB (A100/H100) for headroom.
#   Estimated wall time: ~12h for ~50k samples × 3 epochs at batch 8.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="4b"
EPOCHS="${EPOCHS:-3}"
BATCH_SIZE="${BATCH_SIZE:-8}"
GRAD_ACCUM="${GRAD_ACCUM:-4}"
LR="${LR:-2e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
