#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/root/robot}"
cd "$PACKAGE_ROOT"
export JAX_PLATFORMS=cpu
export JAX_PLATFORM_NAME=cpu
uv run eliza-robot-benchmark-alberta --env joint_reach --steps-per-task 16000 --seeds 3 --out-dir evidence/alberta_joint_reach
uv run eliza-robot-validate-alberta-benchmark evidence/alberta_joint_reach --expected-env joint_reach --min-steps-per-task 16000 --min-seeds 3 --min-tasks 4 --require-alberta-acc-gte-ppo --require-alberta-forgetting-lte-ppo > evidence/alberta_joint_reach/validation_report.json
uv run eliza-robot-benchmark-alberta --env obstacle_course --steps-per-task 16000 --seeds 3 --out-dir evidence/alberta_obstacle_course
uv run eliza-robot-render-alberta-obstacle-demo evidence/alberta_obstacle_course
uv run eliza-robot-validate-alberta-benchmark evidence/alberta_obstacle_course --expected-env obstacle_course --min-steps-per-task 16000 --min-seeds 3 --min-tasks 4 --require-alberta-forgetting-lte-ppo --require-demo-video > evidence/alberta_obstacle_course/validation_report.json
