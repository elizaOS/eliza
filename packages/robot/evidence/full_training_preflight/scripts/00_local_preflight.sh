#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
uv run eliza-robot-validate-training-inputs --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --out evidence/full_training_preflight/training_inputs_report.json
uv run python scripts/validate_multi_robot_training_readiness.py --profiles hiwonder-ainex asimov-1 unitree-g1 unitree-h1 unitree-r1 --commands "stand up" "walk forward" "walk backward" "sidestep left" "sidestep right" "turn left" "turn right" --video-evidence evidence/multi_robot_smoke_videos
uv run python scripts/validate_asimov1_full_training_job.py --job-dir evidence/full_training_preflight/asimov_1_brax_mjx_baseline
uv run python scripts/run_asimov1_full_training.py --job-dir evidence/full_training_preflight/asimov_1_brax_mjx_baseline --check-only --require-ready
uv run eliza-robot-validate-full-training-preflight evidence/full_training_preflight
