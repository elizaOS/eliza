#!/usr/bin/env bash
# Target catalog tier: eliza-1-0_8b (see packages/shared/src/local-inference/catalog.ts)
# Distill the DFlash drafter for Eliza-1 tier 0_8b.
#
# This is the smallest tier. Per distill_dflash_drafter.DEFAULT_STUDENT_BASE,
# the recommended student base is Qwen/Qwen3.5-0.8B — the only Qwen3.5
# variant small enough to function as a drafter for the 0.8B target itself.
# Acceptance gate is 0.40 (tier-baseline; see ACCEPTANCE_GATE).
#
# Hardware (starting-point recipe — TUNE EMPIRICALLY):
#   1× 24GB GPU (A10 / RTX 4090 / RTX 3090). bf16 student fits comfortably.
#   Estimated wall time: ~6h for ~50k samples × 3 epochs at batch 16.
#
# Required env vars (real run):
#   TARGET_CHECKPOINT  HF dir of the fine-tuned eliza-1-0_8b text model
#   TARGET_GGUF        out/eliza-1-0_8b/text/eliza-1-0_8b-32k.gguf
#   DATASET            jsonl from scripts/dflash/prepare_distill_dataset.py
#
# Run synthetic-smoke (no GPU, no real models) with:
#   ./distill_dflash_0_8b.sh --synthetic-smoke

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="0_8b"
EPOCHS="${EPOCHS:-3}"
BATCH_SIZE="${BATCH_SIZE:-16}"
GRAD_ACCUM="${GRAD_ACCUM:-2}"
LR="${LR:-2e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

dflash_run_distill "$@"
