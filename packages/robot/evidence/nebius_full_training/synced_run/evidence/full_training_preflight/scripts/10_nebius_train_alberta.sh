#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
uv run eliza-robot-train --profile asimov-1 --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --steps 150000000 --episode-steps 200 --eval-episodes 3 --out checkpoints/asimov_1_alberta_full --seed 0
