# Alberta Robot Integration Readiness

Status as of 2026-05-23: Alberta is the default text-conditioned robot training
backend. PPO remains available as an explicit baseline with `--backend ppo`,
SAC is available as an optional off-policy Stable-Baselines3 continual-learning
comparison, and Brax/MJX remains the ASIMOV-1 full-training comparison path.

## Upstream

- Vendored source: `packages/alberta`
- Upstream: `https://github.com/lalalune/alberta`
- Verified upstream HEAD: `2ac35333efae45cf969ce02ec1f2703476fed6c2`
- Local vendoring metadata: `packages/alberta/VENDORING.md`
- Clean `uv` installs resolve `alberta-framework` from the editable source
  mapping in `packages/robot/uv.lock`, not from PyPI:
  `source = { editable = "../alberta" }`.

## Default Training Path

```bash
uv run python scripts/train_text_conditioned.py \
  --profile hiwonder-ainex \
  --tasks stand_up walk_forward \
  --steps 30000 \
  --episode-steps 200 \
  --eval-episodes 3

uv run eliza-robot-train \
  --profile hiwonder-ainex \
  --tasks stand_up walk_forward \
  --steps 30000 \
  --episode-steps 200 \
  --eval-episodes 3
```

This writes an `alberta_streaming` checkpoint with:

- `alberta_policy.npz`
- `manifest.json`
- `action_dim`: trained control subset, currently leg joints
- `output_dim`: full profile joint count, so `TextConditionedPolicy.act()` pads
  the policy action into the bridge's full-body joint target vector
- `requested_total_steps`: the user-facing `--steps` budget
- `steps_per_task` / `total_steps`: the rounded per-task phase budget and
  actual env steps run. Wrapper CLIs split `--steps` across the task sequence;
  `python -m eliza_robot.rl.alberta.train_robot --steps-per-task ...` remains
  the explicit per-phase entrypoint.
- `domain_rand`: whether MuJoCo domain randomization was enabled. Alberta
  training enables domain randomization by default; pass `--no-domain-rand`
  only for deterministic debugging.

For `asimov-1`, the Alberta manifest also records `mjcf_xml`,
`mjcf_xml_sha256`, `asset_manifest`, and `asset_manifest_sha256`. The ASIMOV
production checkpoint validator requires those hashes to match the generated
ASIMOV MuJoCo model and asset manifest before a checkpoint can be promoted.

## Supported Profile Smoke Evidence

The default Alberta path has been smoke-run through MuJoCo env construction and
checkpoint manifest writing for every supported profile:

| profile | action_dim | output_dim |
|---|---:|---:|
| `hiwonder-ainex` | 12 | 24 |
| `asimov-1` | 12 | 25 |
| `unitree-g1` | 12 | 29 |
| `unitree-h1` | 10 | 19 |
| `unitree-r1` | 12 | 29 |

The bridge-facing policy-load smoke for `hiwonder-ainex` returned a finite
24-D action with zeros in the untrained full-body tail. The ASIMOV policy-loop
validator now generates an Alberta-format validation checkpoint and has run
through both mock and MuJoCo bridge backends.

Source checkouts resolve profile manifests from `packages/robot/profiles` and
MuJoCo/URDF assets from `packages/robot/assets/profiles`. Wheel-style or mounted
deployments can set `ELIZA_ROBOT_PROFILES_ROOT` and `ELIZA_ROBOT_ASSETS_ROOT`
to the external profile and asset roots instead of bundling the 100MB mesh tree
inside the Python wheel.

The websocket bridge also supports server-side autonomous execution with
`--policy-checkpoint <checkpoint-dir>`. In that mode, `policy.start` runs
`TextConditionedPolicy` in-process and dispatches servo targets. Without a
checkpoint, the existing external `policy.tick` protocol is unchanged. The
inference loop rejects checkpoint/profile or checkpoint/output-dimension
mismatches before sending servo commands.
The interactive MuJoCo viewer follows the same default direction: unless
`--policy-checkpoint` is provided, it first looks for a profile-matching Alberta
checkpoint (`checkpoints/<profile>_alberta_full` or
`checkpoints/alberta_text_conditioned`) before falling back to the historical
SB3 smoke checkpoint and, finally, zero-action rendering.
The evaluator has the same production contract: unless `--untrained` is set,
`scripts/eval_text_policy.py` defaults to `checkpoints/alberta_text_conditioned`,
requires `manifest.json`, and rejects profile or full-output-dimension
mismatches before constructing the MuJoCo env.
Legacy AiNex evidence scripts (`evidence_final_e2e.py`,
`evidence_state_mirror_e2e.py`, `evidence_text_to_action_calibrated_e2e.py`,
and `evidence_vlm_evaluation_e2e.py`) now also default to
`checkpoints/alberta_text_conditioned` and reject checkpoint/profile mismatches
before constructing the HiWonder MuJoCo/real bridge path. The sim validation
gate also defaults to the Alberta checkpoint.
For robot-env comparison evidence, `scripts/compare_text_conditioned_backends.py`
trains Alberta and PPO on the same profile/task/seed/budget/domain-randomization
setting, evaluates both with `scripts/eval_text_policy.py`, and writes one
`comparison.json` artifact.

## Validation Commands

```bash
python3 -m py_compile \
  packages/robot/scripts/train_text_conditioned.py \
  packages/robot/eliza_robot/rl/alberta/train_robot.py \
  packages/robot/eliza_robot/rl/text_conditioned/train.py \
  packages/robot/eliza_robot/rl/text_conditioned/policy.py \
  packages/robot/scripts/compare_text_conditioned_backends.py \
  packages/robot/scripts/evidence_final_e2e.py \
  packages/robot/scripts/evidence_state_mirror_e2e.py \
  packages/robot/scripts/evidence_text_to_action_calibrated_e2e.py \
  packages/robot/scripts/evidence_text_to_action_e2e.py \
  packages/robot/scripts/evidence_vlm_evaluation_e2e.py \
  packages/robot/scripts/interactive_viewer.py \
  packages/robot/scripts/sim_validation_gate.py \
  packages/robot/scripts/prepare_end_to_end_full_training.py \
  packages/robot/scripts/validate_alberta_benchmark_artifacts.py \
  packages/robot/scripts/validate_alberta_robot_checkpoint.py \
  packages/robot/scripts/validate_alberta_vendoring.py \
  packages/robot/scripts/validate_robot_training_inputs.py \
  packages/robot/scripts/validate_asimov1_e2e.py \
  packages/robot/scripts/validate_asimov1_policy_loop.py \
  packages/robot/scripts/validate_asimov1_full_training_job.py \
  packages/robot/scripts/validate_asimov1_production_checkpoint.py \
  packages/robot/scripts/validate_asimov1_real_agent_run.py \
  packages/robot/scripts/validate_multi_robot_training_readiness.py

python3 -m pytest \
  packages/robot/tests/test_profiles.py \
  packages/robot/tests/rl/test_unified_training_cli.py \
  packages/robot/tests/rl/alberta/test_continual_env.py \
  packages/robot/tests/rl/alberta/test_agent_loop.py \
  packages/robot/tests/rl/alberta/test_benchmark_harness.py \
  packages/robot/tests/rl/alberta/test_checkpoint_validator.py \
  packages/robot/tests/rl/alberta/test_metrics.py \
  packages/robot/tests/rl/alberta/test_obstacle_course.py \
  packages/robot/tests/rl/alberta/test_policy_adapter.py \
  packages/robot/tests/rl/alberta/test_vendoring_validator.py \
  packages/robot/tests/rl/test_alberta_evidence_script_defaults.py \
  packages/robot/tests/rl/test_robot_training_inputs_validator.py \
  packages/robot/tests/rl/test_multi_robot_training_readiness.py \
  packages/robot/tests/bridge/test_policy_start_e2e.py \
  packages/robot/tests/asimov_1/test_asimov_docs.py \
  packages/robot/tests/asimov_1/test_eval_text_policy_asimov.py \
  packages/robot/tests/asimov_1/test_completion_gate.py \
  packages/robot/tests/asimov_1/test_e2e_real_hardware_evidence_hook.py \
  packages/robot/tests/asimov_1/test_production_checkpoint_validator.py \
  packages/robot/tests/asimov_1/test_real_agent_readiness.py \
  packages/robot/tests/asimov_1/test_real_agent_runner.py \
  packages/robot/tests/asimov_1/test_real_agent_run_validator.py \
  packages/robot/tests/rl/test_backend_comparison.py \
  packages/robot/tests/rl/test_full_training_preflight.py \
  packages/robot/tests/rl/test_full_training_preflight_validator.py \
  packages/robot/tests/rl/test_text_to_action_e2e_evidence.py \
  -q

python3 packages/robot/scripts/validate_asimov1_policy_loop.py --max-steps 1

python3 packages/robot/scripts/validate_multi_robot_training_readiness.py \
  --profiles hiwonder-ainex asimov-1 unitree-g1 unitree-h1 unitree-r1 \
  --commands "stand up" "walk forward" "turn left" "turn right" \
  --video-evidence packages/robot/evidence/agent_videos

cd packages/robot && uv lock --check

cd packages/robot && uv run eliza-robot-train \
  --profile hiwonder-ainex \
  --dry-run \
  --out /tmp/eliza_robot_train_entrypoint

cd packages/robot && uv run eliza-robot-train-alberta --help
cd packages/robot && uv run eliza-robot-benchmark-alberta --help
cd packages/robot && uv run eliza-robot-compare-backends --help
cd packages/robot && uv run eliza-robot-prepare-full-training --help
cd packages/robot && uv run eliza-robot-validate-alberta-checkpoint --help
cd packages/robot && uv run eliza-robot-validate-asimov1-production-checkpoint --help
cd packages/robot && uv run eliza-robot-validate-alberta-vendoring \
  --expected-upstream-head 2ac35333efae45cf969ce02ec1f2703476fed6c2
cd packages/robot && uv run eliza-robot-validate-training-inputs \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --out /tmp/eliza_training_inputs_report.json

cd packages/robot && uv run python - <<'PY'
from pathlib import Path
import alberta_framework
print(Path(alberta_framework.__file__).resolve())
PY

cd packages/robot && uv run python -m eliza_robot.rl.alberta.benchmark \
  --env obstacle_course \
  --learners alberta ppo sac \
  --n-tasks 2 \
  --steps-per-task 64 \
  --eval-episodes 1 \
  --seeds 1 \
  --out-dir /tmp/eliza_obstacle_benchmark

cd packages/robot && uv run python scripts/compare_text_conditioned_backends.py \
  --profile unitree-g1 \
  --tasks stand_up walk_forward \
  --steps 100 \
  --eval-episodes 1 \
  --max-steps 20 \
  --out-root /tmp/eliza_backend_compare_unitree_g1

cd packages/robot && uv run python scripts/prepare_end_to_end_full_training.py \
  --out-dir /tmp/eliza_full_training_preflight \
  --profile asimov-1 \
  --tasks stand_up walk_forward \
  --alberta-steps 100 \
  --alberta-episode-steps 4 \
  --alberta-eval-episodes 1 \
  --backend-compare-steps 20 \
  --brax-steps 100 \
  --brax-num-envs 16 \
  --brax-num-evals 1 \
  --benchmark-steps-per-task 8 \
  --benchmark-seeds 1
```

Expected result for the broad Alberta/robot evidence pytest slice on
2026-05-23: `86 passed`, with the known JAX `os.fork()` subprocess warning in
the obstacle-demo renderer tests. The readiness validator should report
top-level `"ok": true`.

## Remaining Gates

- Full benchmark execution with production step budgets should run on Nebius:
  both `--env joint_reach` and `--env obstacle_course` should emit
  `continual_benchmark.{json,md,png}` and compare Alberta against PPO on ACC,
  BWT, forgetting, and FWT. The obstacle-course continual benchmark can also
  include `--learners alberta ppo sac` when an off-policy SAC comparison is
  required; local SAC smoke evidence and a rendered Alberta/PPO/SAC demo live
  under `evidence/alberta_obstacle_course_sac_smoke/`.
- Long ASIMOV-1/full-policy training still belongs on Nebius H200. Use
  `scripts/compare_text_conditioned_backends.py` to train/evaluate Alberta and
  PPO under the same profile/task/step budget, then review `comparison.json`.
- Real robot E2E evidence still requires hardware/bridge access and should use
  `scripts/evidence_text_to_action_e2e.py` with a real checkpoint. ASIMOV
  real-agent run reports now archive the production checkpoint validator
  summary, including the Alberta ASIMOV MJCF and asset-manifest provenance
  checks.
- Local CPU hosts with `jax_plugins.xla_cuda12` installed but no CUDA device may
  log a CUDA plugin discovery error before falling back to CPU; the smoke runs
  still complete on CPU.
