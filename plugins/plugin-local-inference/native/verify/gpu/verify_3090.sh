#!/usr/bin/env bash
# verify_3090.sh — RTX 3090 (Ampere sm_86) verification driver.
#
# Wraps _common.sh with the 3090-specific GPU/CUDA arch constants.
# See packages/shared/src/local-inference-gpu/profiles/rtx-3090.yaml
# for the canonical per-bundle deployment recommendations.
set -euo pipefail
PROFILE_ID="rtx-3090"
EXPECTED_SHORT_NAME="3090"
EXPECTED_CUDA_ARCH="86"
export PROFILE_ID EXPECTED_SHORT_NAME EXPECTED_CUDA_ARCH
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
