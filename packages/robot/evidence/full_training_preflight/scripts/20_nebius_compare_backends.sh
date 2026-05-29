#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
export JAX_PLATFORMS=cpu
export JAX_PLATFORM_NAME=cpu
uv run eliza-robot-compare-backends --profile asimov-1 --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --steps 30000 --eval-episodes 5 --max-steps 200 --out-root evidence/backend_compare/asimov-1
uv run eliza-robot-validate-backend-comparison evidence/backend_compare/asimov-1 --expected-profile asimov-1 --min-steps 30000 --min-eval-mean-steps 20 > evidence/backend_compare/asimov-1/validation_report.json
