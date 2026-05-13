#!/usr/bin/env bash
# verify_h200.sh — H200 (Hopper sm_90) verification driver.
#
# Wraps _common.sh with the H200-specific GPU/CUDA arch constants.
# The H200 profile is the marquee Eliza-1 27B at 1M-context config; see
# packages/shared/src/local-inference-gpu/profiles/h200.yaml
# for the canonical per-bundle deployment recommendations. NVLink/SXM
# multi-card setups are explicitly out of scope (single-GPU framing).
set -euo pipefail
PROFILE_ID="h200"
EXPECTED_SHORT_NAME="H200"
EXPECTED_CUDA_ARCH="90"
export PROFILE_ID EXPECTED_SHORT_NAME EXPECTED_CUDA_ARCH
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
