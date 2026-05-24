#!/usr/bin/env bash
set -euo pipefail
MODE="${1:---check}"
JOB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAX_MJX_STEPS="${BRAX_MJX_STEPS:-150000000}"
BRAX_MJX_NUM_ENVS="${BRAX_MJX_NUM_ENVS:-}"
BRAX_MJX_NUM_EVALS="${BRAX_MJX_NUM_EVALS:-}"
BRAX_MJX_EVAL_EPISODES="${BRAX_MJX_EVAL_EPISODES:-5}"
BRAX_MJX_EVAL_MAX_STEPS="${BRAX_MJX_EVAL_MAX_STEPS:-200}"
BRAX_MJX_SKIP_ROLLOUT_EVAL="${BRAX_MJX_SKIP_ROLLOUT_EVAL:-0}"
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
uv run python scripts/validate_asimov1_full_training_job.py --job-dir "$JOB_DIR"
if [[ "$MODE" == "--check" || "$MODE" == "check" ]]; then
  uv run python scripts/run_asimov1_full_training.py --job-dir "$JOB_DIR" --check-only --require-ready
  echo 'ASIMOV-1 full-training package is valid and ready.'
elif [[ "$MODE" == "--train" || "$MODE" == "train" ]]; then
  if [[ "$BRAX_MJX_STEPS" != "150000000" ]]; then
    cp -n "$JOB_DIR/training_job.json" "$JOB_DIR/training_job.full_contract.json"
    uv run python - "$JOB_DIR/training_job.json" "$BRAX_MJX_STEPS" "$BRAX_MJX_NUM_ENVS" "$BRAX_MJX_NUM_EVALS" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
steps = int(sys.argv[2])
num_envs = int(sys.argv[3]) if sys.argv[3] else None
num_evals = int(sys.argv[4]) if sys.argv[4] else None
job = json.loads(path.read_text(encoding='utf-8'))
old_steps = int(job.get('ppo', {}).get('num_timesteps', 0) or 0)
ppo = job.setdefault('ppo', {})
ppo['num_timesteps'] = steps
if num_envs is not None:
    ppo['num_envs'] = num_envs
if num_evals is not None:
    ppo['num_evals'] = num_evals
job.setdefault('manifest_template', {})['total_steps'] = steps
commands = job.get('validation_commands')
if isinstance(commands, list):
    job['validation_commands'] = [
        str(command).replace(f'--min-steps {old_steps}', f'--min-steps {steps}')
        for command in commands
    ]
path.write_text(json.dumps(job, indent=2) + '\n', encoding='utf-8')
PY
  fi
  if [[ "${BRAX_MJX_REUSE_EXISTING:-0}" == "1" && -s "$JOB_DIR/policy_brax.pkl" ]]; then
    uv run python - "$JOB_DIR" <<'PY'
import json
import sys
from pathlib import Path
from scripts.run_asimov1_full_training import (
    build_training_run_report,
    run_post_training_validation,
)
job_dir = Path(sys.argv[1])
post = run_post_training_validation(job_dir)
report = build_training_run_report(
    job_dir,
    training={"ok": True, "job_dir": str(job_dir), "policy": str(job_dir / "policy_brax.pkl"), "reused_existing": True},
    post_training_validation=post,
)
(job_dir / "full_training_run.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
raise SystemExit(0 if report["ok"] else 2)
PY
  else
    uv run python scripts/run_asimov1_full_training.py --job-dir "$JOB_DIR" --out "$JOB_DIR/full_training_run.json"
  fi
  export JAX_PLATFORMS=cpu
  export JAX_PLATFORM_NAME=cpu
  unset CUDA_VISIBLE_DEVICES
  uv run python scripts/validate_asimov1_full_training_run.py "$JOB_DIR/full_training_run.json" --job-dir "$JOB_DIR"
  uv run python scripts/verify_brax_text_policy.py --ckpt "$JOB_DIR" --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25 --require-critic-obs-dim 86 --require-policy-obs-key state --require-value-obs-key privileged_state
  # Production contract default: --min-steps 150000000
  uv run python scripts/validate_asimov1_production_checkpoint.py "$JOB_DIR" --min-steps "$BRAX_MJX_STEPS" --require-inference-check
  if [[ "$BRAX_MJX_SKIP_ROLLOUT_EVAL" != "1" ]]; then
    uv run python scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt "$JOB_DIR" --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes "$BRAX_MJX_EVAL_EPISODES" --max-steps "$BRAX_MJX_EVAL_MAX_STEPS"
    uv run python scripts/sim_validation_gate.py --profile asimov-1 --checkpoint "$JOB_DIR" --require-asimov-model-provenance
  fi
else
  echo "usage: $0 [--check|--train]" >&2
  exit 64
fi
