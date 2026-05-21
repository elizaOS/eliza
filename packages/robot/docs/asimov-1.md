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

Promotion reports include source/destination hashes for MJCF, URDF, manifest,
and mesh copies. Validate a workspace promotion plan before applying it:

```bash
python3 packages/robot/scripts/validate_asimov1_workspace_promotion.py \
  --workspace /tmp/asimov-edit-workspace
```

After running `promote_asimov1_workspace(..., dry_run=False)` or
`promote_asimov1_workspace.py --apply`, require destination hashes to match:

```bash
python3 packages/robot/scripts/validate_asimov1_workspace_promotion.py \
  --workspace /tmp/asimov-edit-workspace \
  --require-applied
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
`validate_asimov1_production_checkpoint.py` with the job's training-step
target, `eval_text_policy.py --backend mjx`, and `sim_validation_gate.py`
against the produced checkpoint. Keep production-scale runs off local
developer machines; use a GPU training host and keep checkpoints out of git.

Smoke checkpoints from `rl/text_conditioned/train.py` are deterministic
contract artifacts. They verify bridge and policy plumbing but are not walking
policies.

The MJX training environment preserves the Menlo actor observation contract:
45 proprioceptive values plus the text embedding. The proprioceptive joint
position and velocity slices are selected from configurable left/right leg
history buffers (`observation_delay_steps`) so training can model the staggered
bus timing described in Menlo's walking writeup without changing the actor
shape.

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

On a hardware host, run the telemetry-only probe before any motion command:

```bash
ASIMOV_LIVEKIT_URL=wss://... ASIMOV_LIVEKIT_TOKEN=... \
python3 packages/robot/scripts/validate_asimov1_real_telemetry_probe.py \
  --timeout 15
```

The probe connects to the LiveKit room and waits for one `EdgeTelemetry` frame.
It publishes zero `CloudCommand` messages.

After telemetry is healthy and the robot is physically safe to command, the
staged command probe sends only DAMP by default:

```bash
ASIMOV_LIVEKIT_URL=wss://... ASIMOV_LIVEKIT_TOKEN=... \
python3 packages/robot/scripts/validate_asimov1_real_command_probe.py \
  --timeout 15
```

STAND and zero-velocity are opt-in:

```bash
ASIMOV_LIVEKIT_URL=wss://... ASIMOV_LIVEKIT_TOKEN=... \
python3 packages/robot/scripts/validate_asimov1_real_command_probe.py \
  --timeout 15 \
  --allow-stand \
  --allow-zero-velocity
```

For production evidence on a hardware host, collect preflight, telemetry, and
the staged command probe into one JSON report:

```bash
ASIMOV_LIVEKIT_URL=wss://... ASIMOV_LIVEKIT_TOKEN=... \
python3 packages/robot/scripts/collect_asimov1_real_hardware_evidence.py \
  --timeout 15 \
  --require-modules \
  --out /tmp/asimov-real-hardware/
```

By default this evidence runner stops after a failed strict preflight and, if
preflight passes, sends only the DAMP command after telemetry is healthy. Add
`--allow-stand --allow-zero-velocity` only when the robot is physically ready
for those command stages.

Validate a captured report before treating it as real-hardware evidence:

```bash
python3 packages/robot/scripts/validate_asimov1_real_hardware_evidence.py \
  /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json
```

Validate the real-agent command and policy-loop contract before enabling a
physical robot:

```bash
python3 packages/robot/scripts/validate_asimov1_real_agent_readiness.py \
  --max-steps 2
```

When production checkpoint and hardware evidence are available, require both:

```bash
python3 packages/robot/scripts/validate_asimov1_real_agent_readiness.py \
  --checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --require-production \
  --require-hardware
```

The guarded real-agent runner prints a no-motion launch plan unless
`--allow-motion` is supplied. Use it only after production checkpoint and
hardware evidence validation pass:

```bash
ASIMOV_LIVEKIT_URL=wss://... ASIMOV_LIVEKIT_TOKEN=... \
python3 packages/robot/scripts/run_asimov1_real_agent.py \
  --checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --task walk_forward \
  --max-steps 100
```

To actually connect and command hardware, add `--allow-motion`; without that
flag the script does not connect to LiveKit or publish commands.

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
real-agent readiness, real-mode dry-run/preflight, and the live audit for
released ASIMOV model artifacts.

The tiny Brax/MJX job proves integration only; it is not production walking
evidence. Once a real training run has produced `policy_brax.pkl`,
`manifest.json`, `metrics.json`, and `config.json`, validate the checkpoint
package with an explicit training-step threshold:

```bash
python3 packages/robot/scripts/validate_asimov1_production_checkpoint.py \
  /path/to/asimov-production-checkpoint \
  --min-steps 150000000
```

When a hardware-host report exists, include it in the gate:

```bash
python3 packages/robot/scripts/validate_asimov1_e2e.py \
  --out /tmp/asimov-e2e \
  --steps 2 \
  --real-hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json
```

When both production training and hardware evidence exist, include both:

```bash
python3 packages/robot/scripts/validate_asimov1_e2e.py \
  --out /tmp/asimov-e2e \
  --steps 2 \
  --production-checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --real-hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json
```

To include CAD/MJCF promotion evidence in the same gate, add the workspace:

```bash
python3 packages/robot/scripts/validate_asimov1_e2e.py \
  --out /tmp/asimov-e2e \
  --steps 2 \
  --workspace-promotion /tmp/asimov-edit-workspace
```

Use `--require-promotion-applied` when the modified workspace has been copied
into `assets/profiles/asimov-1/` and the destination hashes must match the
workspace outputs.

The strict completion gate requires an E2E report that already included the
same production checkpoint and hardware evidence, confirms the parsed real
agent readiness report was `production_ready`, then validates the artifacts
again:

```bash
python3 packages/robot/scripts/validate_asimov1_completion.py \
  --e2e-report /tmp/asimov-e2e/asimov1_e2e_report.json \
  --production-checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json
```

This command is intentionally strict: it fails unless the final E2E run,
real-agent readiness report, production training artifact, and hardware
evidence all refer to the same ASIMOV-1 integration state.
