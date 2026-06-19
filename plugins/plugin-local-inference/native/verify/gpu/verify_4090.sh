#!/usr/bin/env bash
# verify_4090.sh — RTX 4090 (Ada Lovelace sm_89) verification driver.
#
# Wraps _common.sh with the 4090-specific GPU/CUDA arch constants.
# See packages/shared/src/local-inference-gpu/profiles/rtx-4090.yaml
# for the canonical per-bundle deployment recommendations.
set -euo pipefail
PROFILE_ID="rtx-4090"
EXPECTED_SHORT_NAME="4090"
EXPECTED_CUDA_ARCH="89"
export PROFILE_ID EXPECTED_SHORT_NAME EXPECTED_CUDA_ARCH
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
