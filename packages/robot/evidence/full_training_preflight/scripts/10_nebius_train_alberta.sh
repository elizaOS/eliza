#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
ALBERTA_STREAMING_STEPS="${ALBERTA_STREAMING_STEPS:-100}"
export JAX_PLATFORMS=cpu
export JAX_PLATFORM_NAME=cpu
uv run eliza-robot-train --profile asimov-1 --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --steps "$ALBERTA_STREAMING_STEPS" --episode-steps 11 --eval-episodes 2 --out checkpoints/asimov_1_alberta_full --seed 0 --require-phase-success --min-phase-success-rate 1.0
