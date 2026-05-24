# Nebius H200 Launch: Alberta Text-Conditioned Robots

This is the handoff runbook for long robot training. The default training path
is Alberta streaming continual learning over the profile-driven MuJoCo env.
PPO/Brax jobs remain comparison baselines, not the default path.

## Phase 0: Local Readiness Gate

Run this before spending GPU time:

```bash
cd packages/robot
python3 scripts/prepare_end_to_end_full_training.py \
  --out-dir evidence/full_training_preflight

python3 scripts/validate_multi_robot_training_readiness.py \
  --profiles hiwonder-ainex asimov-1 unitree-g1 unitree-h1 unitree-r1 \
  --commands "stand up" "walk forward" "turn left" "turn right" \
  --video-evidence evidence/agent_videos

uv run eliza-robot-validate-full-training-preflight \
  evidence/full_training_preflight
```

Expected shape:

- top-level `"ok": true`
- every profile reports `ok: true`
- `alberta.ok: true`
- video evidence contains per-action videos plus one combined-actions mp4 per profile
- `evidence/full_training_preflight/preflight_report.json` has top-level
  `"ok": true` and contains executable launch scripts in
  `evidence/full_training_preflight/scripts/`
- generated scripts run from `ELIZA_ROBOT_PACKAGE_ROOT` when set, otherwise
  from the package root that created the bundle
- `scripts/run_all_nebius_stages.sh` is present and delegates to
  `eliza-robot-run-full-training-bundle` for START/END logs, status markers,
  and optional object-storage heartbeats

## Phase 1: Bring Up The Host

Do not embed Object Storage access-key values in `cloud_init_user_data`.
Nebius Object Storage uses AWS-compatible access keys for service-account
authentication, so configure those credentials through an external runtime
secret channel or an already provisioned host profile, then validate the final
instance JSON before treating the launch as production evidence:

```bash
uv run eliza-robot-validate-nebius-instance-launch instance.json
```

That validator must report `ok: true`: the launch must use
`NEBIUS_TRAINING_S3_URI`, `NEBIUS_S3_ENDPOINT`, and the repo-owned
`eliza-robot-run-full-training-bundle`/`run_all_nebius_stages.sh` path so
`status/runner_status.json` and every `status/<stage>.json` are uploaded during
long stages.

```bash
ssh <nebius-h200-host>
sudo apt update
sudo apt install -y git build-essential python3.12 python3.12-venv ffmpeg
git clone <repo-url> eliza
cd eliza/packages/robot
python3.12 -m venv .venv
source .venv/bin/activate
pip install -U pip wheel
pip install -e . -e ../alberta
pip install "jax[cuda12]" mujoco mujoco-mjx brax stable-baselines3 sentence-transformers scikit-learn
```

Verify the installed package resolves the vendored Alberta framework:

```bash
python - <<'PY'
from eliza_robot.rl.alberta.agent import AlbertaContinualController
from eliza_robot.rl.alberta.train_robot import train_robot
print(AlbertaContinualController.__name__, train_robot.__name__)
PY
```

To run the generated numbered stages with auditable logs and periodic
log/status upload, set the object-storage prefix and use the bundle runner:

```bash
export NEBIUS_TRAINING_S3_URI=s3://<bucket>/<run-id>
export NEBIUS_S3_ENDPOINT=https://storage.eu-north1.nebius.cloud
evidence/full_training_preflight/scripts/run_all_nebius_stages.sh
```

The runner writes `logs/<stage>.log`, `status/<stage>.json`,
`status/runner_status.json`, and `status/success.txt` or
`status/failure.txt`. During long stages it can sync `logs/` and `status/` to
the configured prefix before the stage exits.

## Phase 2: H200 Smoke

Use a tiny run to prove MuJoCo assets, task embeddings, checkpoint writing, and
policy loading on the host:

```bash
python scripts/train_text_conditioned.py \
  --profile hiwonder-ainex \
  --backend alberta \
  --tasks stand_up \
  --steps 32 \
  --episode-steps 4 \
  --eval-episodes 1 \
  --out /tmp/alberta_h200_smoke

python - <<'PY'
import numpy as np
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy
p = TextConditionedPolicy("/tmp/alberta_h200_smoke")
a, task = p.act("stand up", np.zeros(45, dtype=np.float32))
print(task, a.shape, np.isfinite(a).all())
PY

python -m eliza_robot.bridge.server \
  --backend mock \
  --profile hiwonder-ainex \
  --policy-checkpoint /tmp/alberta_h200_smoke \
  --host 127.0.0.1 \
  --port 19100
```

The installed console entrypoint is equivalent and is what the generated
preflight launch scripts use:

```bash
uv run eliza-robot-train \
  --profile asimov-1 \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --steps 150000000 \
  --episode-steps 200 \
  --eval-episodes 3 \
  --out checkpoints/asimov_1_alberta_h200 \
  --seed 0
```

Expected: `stand_up`, full profile action shape `(24,)`, and finite actions.
With `--policy-checkpoint`, `policy.start` runs the Alberta checkpoint
server-side and dispatches servo targets; without it, clients must continue to
send explicit `policy.tick` payloads.

## Phase 3: Production Alberta Training

Train the supported task sequence for the target robot. For the first H200 run,
use ASIMOV-1 unless the hardware plan says otherwise:

```bash
python scripts/train_text_conditioned.py \
  --profile asimov-1 \
  --backend alberta \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --steps 150000000 \
  --episode-steps 200 \
  --eval-episodes 3 \
  --out checkpoints/asimov_1_alberta_h200 \
  --seed 0
```

Checkpoint contract:

- `manifest.json`
- `alberta_policy.npz`
- `manifest.regime == "alberta_streaming"`
- `manifest.action_dim` is the trained leg-control subset
- `manifest.output_dim` is the full robot joint count for bridge padding
- `manifest.requested_total_steps == 150000000`
- `manifest.steps_per_task` is the rounded per-task phase budget. The wrapper
  CLI treats `--steps` as a total budget and splits it over the task sequence;
  use `python -m eliza_robot.rl.alberta.train_robot --steps-per-task ...` only
  when you intentionally want an explicit per-task budget.
- `manifest.domain_rand == true` for production runs. Pass `--no-domain-rand`
  only for deterministic debugging or reproduction of a local issue.
- `manifest.mjcf_xml_sha256` and `manifest.asset_manifest_sha256` match the
  generated ASIMOV-1 MuJoCo model and asset manifest.

## Phase 4: Pull Artifacts

```bash
rsync -a <nebius-h200-host>:eliza/packages/robot/checkpoints/asimov_1_alberta_h200/ \
  ./packages/robot/checkpoints/asimov_1_alberta_h200/
```

Do not commit checkpoint binaries. Store long-run artifacts in object storage
or the agreed checkpoint bucket.

## Phase 5: Post-Train Validation

```bash
cd packages/robot
uv run eliza-robot-validate-alberta-checkpoint \
  checkpoints/asimov_1_alberta_h200 \
  --profile asimov-1 \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --min-steps 150000000 \
  --require-domain-rand \
  --require-inference

uv run eliza-robot-validate-asimov1-production-checkpoint \
  checkpoints/asimov_1_alberta_h200 \
  --min-steps 150000000 \
  --require-inference-check

python scripts/eval_text_policy.py \
  --profile asimov-1 \
  --ckpt checkpoints/asimov_1_alberta_h200 \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --episodes 5 \
  --max-steps 200

python scripts/evidence_text_to_action_e2e.py \
  --checkpoint checkpoints/asimov_1_alberta_h200 \
  --no-real

python -m eliza_robot.bridge.server \
  --backend asimov_mujoco \
  --profile asimov-1 \
  --policy-checkpoint checkpoints/asimov_1_alberta_h200 \
  --host 127.0.0.1 \
  --port 19101
```

The real robot pass should be run only after the sim-only validation is clean:

```bash
python scripts/evidence_text_to_action_e2e.py \
  --checkpoint checkpoints/asimov_1_alberta_h200 \
  --host 192.168.1.218 \
  --port 9090 \
  --obsbot-device 4
```

## Baselines

Use PPO only when explicitly collecting comparison evidence:

```bash
python scripts/train_text_conditioned.py \
  --profile asimov-1 \
  --backend ppo \
  --tasks stand_up walk_forward turn_left turn_right \
  --steps 30000 \
  --out checkpoints/asimov_1_ppo_smoke
```

For one packaged Alberta-vs-PPO robot-env artifact, run:

```bash
python scripts/compare_text_conditioned_backends.py \
  --profile asimov-1 \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --steps 150000000 \
  --eval-backend mjx \
  --out-root evidence/asimov_1_alberta_vs_ppo
```

The generated preflight bundle uses `uv run eliza-robot-compare-backends` for
the same comparison path.

For continual-learning evidence independent of heavy humanoid physics, run both
fast benchmark environments and keep their JSON/Markdown/PNG outputs:

```bash
python -m eliza_robot.rl.alberta.benchmark \
  --env joint_reach \
  --steps-per-task 16000 \
  --seeds 3 \
  --out-dir evidence/alberta_joint_reach

python -m eliza_robot.rl.alberta.benchmark \
  --env obstacle_course \
  --steps-per-task 16000 \
  --seeds 3 \
  --out-dir evidence/alberta_obstacle_course
```

Full ASIMOV-1 Brax/MJX PPO packaging still exists in
`scripts/run_asimov1_full_training.py` and
`eliza_robot/sim/mujoco/asimov_mjx_training.py`. That path is for baseline and
comparison runs, not the Alberta default.
