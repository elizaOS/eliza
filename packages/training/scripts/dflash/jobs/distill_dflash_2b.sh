#!/usr/bin/env bash
# Target catalog tier: eliza-1-2b (see packages/shared/src/local-inference/catalog.ts)
# Distill the DFlash drafter for Eliza-1 tier 2b.
#
# Student base: Qwen/Qwen3.5-0.8B (small student, 2B target → good headroom).
# Acceptance gate: 0.50.
#
# Hardware (starting-point — TUNE EMPIRICALLY):
#   1× 24GB GPU. Student + target both fit in bf16.
#   Estimated wall time: ~8–10h for ~50k samples × 3 epochs at batch 16.

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="2b"
EPOCHS="${EPOCHS:-3}"
BATCH_SIZE="${BATCH_SIZE:-16}"
GRAD_ACCUM="${GRAD_ACCUM:-2}"
LR="${LR:-2e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
