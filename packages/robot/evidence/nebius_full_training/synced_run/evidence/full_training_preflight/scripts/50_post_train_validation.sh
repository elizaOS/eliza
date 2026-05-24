#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
uv run eliza-robot-validate-alberta-checkpoint checkpoints/asimov_1_alberta_full --profile asimov-1 --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --min-steps 150000000 --require-domain-rand --require-inference
uv run eliza-robot-validate-asimov1-production-checkpoint checkpoints/asimov_1_alberta_full --min-steps 150000000 --require-inference-check
uv run python scripts/validate_asimov1_real_agent_readiness.py --checkpoint checkpoints/asimov_1_alberta_full --production-min-steps 150000000 --require-production --max-steps 2
uv run python scripts/eval_text_policy.py --profile asimov-1 --ckpt checkpoints/asimov_1_alberta_full --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes 5 --max-steps 200
uv run python scripts/evidence_text_to_action_e2e.py --checkpoint checkpoints/asimov_1_alberta_full --profile asimov-1 --no-real
uv run python scripts/record_agent_videos.py --profiles asimov-1 --commands "stand up" "walk forward" "turn left" "turn right" --out evidence/agent_videos --max-steps 200 --policy-checkpoint checkpoints/asimov_1_alberta_full
