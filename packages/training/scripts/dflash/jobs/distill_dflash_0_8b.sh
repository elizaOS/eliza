#!/usr/bin/env bash
# Target catalog tier: eliza-1-0_8b (see packages/shared/src/local-inference/catalog.ts)
# Emit the DFlash no-drafter release policy for Eliza-1 tier 0_8b.
#
# This is the smallest tier. DFlash is disabled here: a 0.8B-class drafter
# duplicates the target's resident memory, is not smaller than the target in
# the current smoke, and has poor speedup economics on low-memory devices.
# Do not train or stamp a fake `drafter-0_8b.gguf`.
#
# Run:
#   ./distill_dflash_0_8b.sh
#
# Output:
#   dflash-disabled-0_8b.release-policy.json

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
