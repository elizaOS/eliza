#!/usr/bin/env bash
# Metadata-only EAGLE3 pipeline smoke for the eliza-1-0_8b target tier.
#
# Run:
#   bash packages/training/scripts/eagle3/jobs/eagle3_0_8b_smoke.sh --synthetic-smoke

set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${script_dir}/_lib.sh"

TIER="0_8b"
SYNTHETIC_SAMPLES="${SYNTHETIC_SAMPLES:-16}"
EPOCHS="${EPOCHS:-1}"
BATCH_SIZE="${BATCH_SIZE:-8}"
GRAD_ACCUM="${GRAD_ACCUM:-4}"
LR="${LR:-2e-4}"
MAX_SEQ_LEN="${MAX_SEQ_LEN:-2048}"

eagle3_run_pipeline "$@"

