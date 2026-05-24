#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
ALBERTA_STREAMING_STEPS="${ALBERTA_STREAMING_STEPS:-150000000}"
uv run eliza-robot-validate-alberta-checkpoint checkpoints/asimov_1_alberta_full --profile asimov-1 --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --min-steps "$ALBERTA_STREAMING_STEPS" --require-domain-rand --require-inference
uv run eliza-robot-validate-asimov1-production-checkpoint checkpoints/asimov_1_alberta_full --min-steps "$ALBERTA_STREAMING_STEPS" --require-inference-check
uv run python scripts/validate_asimov1_real_agent_readiness.py --checkpoint checkpoints/asimov_1_alberta_full --production-min-steps "$ALBERTA_STREAMING_STEPS" --require-production --max-steps 2
uv run python scripts/eval_text_policy.py --profile asimov-1 --ckpt checkpoints/asimov_1_alberta_full --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes 5 --max-steps 200
uv run python scripts/evidence_text_to_action_e2e.py --checkpoint checkpoints/asimov_1_alberta_full --profile asimov-1 --no-real
uv run python scripts/record_agent_videos.py --profiles asimov-1 --commands "stand up" "walk forward" "turn left" "turn right" --out evidence/agent_videos --max-steps 200 --policy-checkpoint checkpoints/asimov_1_alberta_full
uv run eliza-robot-review-video-evidence --evidence-dir evidence/agent_videos --out-dir evidence/video_review --require-telemetry
uv run eliza-robot-generate-alberta-report --package-root . --scope production-nebius-post-training --backend-dir evidence/backend_compare/asimov-1 --backend-validation evidence/backend_compare/asimov-1/validation_report.json --obstacle-dir evidence/alberta_obstacle_course --obstacle-validation evidence/alberta_obstacle_course/validation_report.json --video-review evidence/video_review/video_review.json --video-manifest evidence/agent_videos/manifest.json --out-json evidence/ALBERTA_END_TO_END_REPORT.json --out-md evidence/ALBERTA_END_TO_END_REPORT.md
