#!/usr/bin/env bash
# verify_5090.sh — RTX 5090 (Blackwell sm_120) verification driver.
#
# Wraps _common.sh with the 5090-specific GPU/CUDA arch constants.
# Requires CUDA Toolkit 12.8+ for sm_120 support. See
# packages/shared/src/local-inference-gpu/profiles/rtx-5090.yaml
# for the canonical per-bundle deployment recommendations.
set -euo pipefail
PROFILE_ID="rtx-5090"
EXPECTED_SHORT_NAME="5090"
EXPECTED_CUDA_ARCH="120"
export PROFILE_ID EXPECTED_SHORT_NAME EXPECTED_CUDA_ARCH
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
