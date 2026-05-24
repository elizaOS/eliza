#!/usr/bin/env bash
set -euo pipefail
MODE="${1:---check}"
JOB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
uv run python scripts/validate_asimov1_full_training_job.py --job-dir "$JOB_DIR"
if [[ "$MODE" == "--check" || "$MODE" == "check" ]]; then
  uv run python scripts/run_asimov1_full_training.py --job-dir "$JOB_DIR" --check-only --require-ready
  echo 'ASIMOV-1 full-training package is valid and ready.'
elif [[ "$MODE" == "--train" || "$MODE" == "train" ]]; then
  uv run python scripts/run_asimov1_full_training.py --job-dir "$JOB_DIR" --out "$JOB_DIR/full_training_run.json"
  uv run python scripts/validate_asimov1_full_training_run.py "$JOB_DIR/full_training_run.json" --job-dir "$JOB_DIR"
  uv run python scripts/verify_brax_text_policy.py --ckpt "$JOB_DIR" --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25 --require-critic-obs-dim 86 --require-policy-obs-key state --require-value-obs-key privileged_state
  uv run python scripts/validate_asimov1_production_checkpoint.py "$JOB_DIR" --min-steps 150000000 --require-inference-check
  uv run python scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt "$JOB_DIR" --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes 5 --max-steps 200
  uv run python scripts/sim_validation_gate.py --profile asimov-1 --checkpoint "$JOB_DIR" --require-asimov-model-provenance
else
  echo "usage: $0 [--check|--train]" >&2
  exit 64
fi
