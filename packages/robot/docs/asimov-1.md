# ASIMOV-1 Integration

ASIMOV-1 support is profile-driven under `profiles/asimov-1/` and uses the
vendored `asimovinc/asimov-1` checkout at `vendor/asimov-1` as the source of
truth for CAD, electrical assets, meshes, and the upstream MuJoCo model.

The generated runtime assets live under `assets/profiles/asimov-1/`. The
MuJoCo XML at `assets/profiles/asimov-1/mjcf/asimov_eliza.xml` is authoritative
for simulation and training. `assets/profiles/asimov-1/asimov.urdf` is generated
from the same MJCF hierarchy for tools that need URDF input; it preserves the
kinematic tree, inertials, joint limits, and visual mesh references, but MuJoCo
remains the dynamics authority.

## Source Inventory

Check that the submodule is configured, checked out, and registered as a parent
gitlink:

```bash
python3 packages/robot/scripts/check_asimov1_source_inventory.py
```

Regenerate the profile MuJoCo model, URDF, and asset manifest from the pinned
source:

```bash
python3 packages/robot/scripts/generate_asimov1_mujoco.py
```

The generated MJCF must compile with MuJoCo and expose 25 actuators. The
generated URDF should contain the ASIMOV kinematic/visual tree and 28 STL mesh
references.

## CAD And MuJoCo Edit Loop

Create a self-contained edit workspace outside the vendor gitlink:

```bash
python3 packages/robot/scripts/prepare_asimov1_edit_workspace.py \
  --workspace /tmp/asimov-edit \
  --force
```

Apply a structured MJCF patch and regenerate workspace outputs:

```bash
cat >/tmp/asimov-patch.json <<'JSON'
{
  "joints": {
    "left_ankle_roll_joint": {
      "range": [-0.12, 0.12],
      "armature": 0.057
    }
  },
  "comment": "local ASIMOV-1 edit"
}
JSON

python3 packages/robot/scripts/patch_asimov1_mjcf.py \
  --workspace /tmp/asimov-edit \
  --patch /tmp/asimov-patch.json \
  --regenerate
```

Review the promotion plan before copying generated assets back into the
package:

```bash
python3 packages/robot/scripts/promote_asimov1_workspace.py \
  --workspace /tmp/asimov-edit
```

Only add `--apply` after reviewing `asimov_promotion_plan.json`. Promotion
copies the regenerated MJCF, URDF, asset manifest, and 28 STL meshes into the
profile asset directory.

The full edit loop gate is:

```bash
python3 packages/robot/scripts/validate_asimov1_cad_edit_loop.py
```

## Simulation And Training

Run the profile simulation gate:

```bash
python3 packages/robot/scripts/sim_validation_gate.py --profile asimov-1 --steps 2
```

Create and validate a full text-conditioned PPO job:

```bash
python3 packages/robot/scripts/validate_asimov1_full_training_job.py \
  --create \
  --job-dir /tmp/asimov-full-training

python3 packages/robot/scripts/run_asimov1_full_training.py \
  --job-dir /tmp/asimov-full-training \
  --check-only \
  --require-ready

/tmp/asimov-full-training/run_full_training.sh --check
```

The exported `run_full_training.sh` embeds the robot package root at generation
time, so it can be launched from another working directory. `--check` validates
the package and installed training dependencies. `--train` starts the real
Brax/MJX PPO path and then runs `verify_brax_text_policy.py`,
`eval_text_policy.py --backend mjx`, and `sim_validation_gate.py` against the
produced checkpoint. Keep production-scale runs off local developer machines;
use a GPU training host and keep checkpoints out of git.

Smoke checkpoints from `rl/text_conditioned/train.py` are deterministic
contract artifacts. They verify bridge and policy plumbing but are not walking
policies.

For a bounded proof of the real Brax/MJX trainer entrypoint, create a tiny
non-production job first:

```bash
python3 packages/robot/scripts/validate_asimov1_tiny_brax_training.py \
  --job-dir /tmp/asimov-tiny-brax \
  --create
```

Run the actual tiny PPO path only when CPU compile time or a GPU host is
acceptable:

```bash
CUDA_VISIBLE_DEVICES='' JAX_PLATFORMS=cpu JAX_PLATFORM_NAME=cpu \
python3 packages/robot/scripts/validate_asimov1_tiny_brax_training.py \
  --job-dir /tmp/asimov-tiny-brax \
  --run-training
```

This writes `policy_brax.pkl`, `manifest.json`, `metrics.json`, `config.json`,
and `tiny_brax_training_validation.json`, then loads the checkpoint through
`TextConditionedPolicy`. It is an integration proof, not a walking checkpoint.

Evaluate a checkpoint in the ASIMOV MJX environment:

```bash
python3 packages/robot/scripts/eval_text_policy.py \
  --profile asimov-1 \
  --backend mjx \
  --ckpt /tmp/asimov-full-training \
  --tasks stand_up walk_forward \
  --episodes 1 \
  --max-steps 20
```

`--backend mjx` is the training-grade ASIMOV evaluator. It can be slow on CPU
because JAX compiles the MuJoCo/MJX step path; use `--backend profile` only for
quick local smoke checks.

## Bridge Targets

Local command loop validation:

```bash
python3 packages/robot/scripts/validate_asimov1_policy_loop.py --max-steps 2
python3 packages/robot/scripts/validate_asimov1_server_command_surface.py
```

Available ASIMOV bridge targets:

- `asimov`: mock ASIMOV backend for command-surface testing.
- `asimov-mujoco`: generated MJCF backend for local MuJoCo stepping.
- `asimov-real`: LiveKit/protobuf bridge for real hardware.

ASIMOV-native commands are `asimov.mode`, `asimov.velocity`, and
`asimov.trajectory`. The ASIMOV backends also accept the generic bridge aliases:
`walk.command` with `action=start|stop` maps to STAND/DAMP, `walk.command` or
`walk.set` with velocity fields (`vx_mps`/`vy_mps`/`yaw_rad_s`, or `x`/`y`/`yaw`)
maps to the ASIMOV velocity controller, and `servo.set`/`policy.tick` with 25-D
joint targets maps to the trajectory controller.

The real bridge publishes Menlo `CloudCommand` protobufs to the LiveKit
`commands` topic and parses `EdgeTelemetry` frames. Validate prerequisites
before using it:

```bash
python3 packages/robot/scripts/check_asimov1_real_prereqs.py
```

Dry-run the real command path locally, without hardware, by injecting fake
LiveKit and protobuf objects. This verifies that `asimov-real` connects,
publishes mode, velocity, and trajectory `CloudCommand` payloads to the
`commands` topic, parses an `EdgeTelemetry` payload, and shuts down cleanly:

```bash
python3 packages/robot/scripts/validate_asimov1_real_bridge_dry_run.py
```

Strict real-mode validation requires the LiveKit SDK, the Menlo edge protobuf
package, `ASIMOV_LIVEKIT_URL`, `ASIMOV_LIVEKIT_TOKEN`, and physical robot
access.

## End-To-End Gate

Run the full integration gate:

```bash
python3 packages/robot/scripts/validate_asimov1_e2e.py \
  --out /tmp/asimov-e2e \
  --steps 2
```

This covers source inventory, generated assets, CAD edit regeneration, smoke
policy contract, full-training readiness, exported runner checks, the tiny
Brax/MJX trainer validation package, MuJoCo/MJX gates, bridge targets,
real-mode dry-run/preflight, and the live audit for released ASIMOV model
artifacts.
