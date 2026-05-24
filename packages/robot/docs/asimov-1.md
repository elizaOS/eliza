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

Generate the MuJoCo load proof consumed by the morphology and parametric CAD
gates:

```bash
python3 packages/robot/scripts/generate_asimov1_mujoco_load_proof.py
```

Use the strict form before claiming physics integration is ready:

```bash
python3 packages/robot/scripts/generate_asimov1_mujoco_load_proof.py \
  --require-ok
```

The proof first checks the packaged MJCF statically: `../meshes` must resolve,
all 28 mesh files must exist, the 25 position actuators must match
`ASIMOV1_FIRMWARE_JOINT_ORDER`, and foot/body collision geoms must be present.
When the `mujoco` Python package is installed, the same proof also compiles the
model, runs `mj_forward`, and steps once. A failed proof is still written to
`cad/asimov-feminine/proofs/mujoco-load.json` so downstream gates can show the
exact missing condition.

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

Inventory the current STL links against the parametric-CAD target:

```bash
python3 packages/robot/scripts/inventory_asimov1_parametric_meshes.py
```

This report distinguishes current mesh-derived section-loft/body-shape
experiments from proven STEP/loft parametric reconstructions. As of the current
asset set, all 28 ASIMOV visual meshes have connection specs, part scripts, and
output STLs under `cad/asimov-feminine/`, but none are yet marked
`proven_against_step`. Use the stricter gate when a change claims complete
parametric coverage:

```bash
python3 packages/robot/scripts/inventory_asimov1_parametric_meshes.py \
  --require-fully-parametric
```

That gate must remain failing until every mesh has a source STEP/B-rep or
controlled section-loft source, per-spline fit error, mesh-vs-surface distance
bounds, connection-plane preservation, watertight/manifold proof, and a MuJoCo
load check with unchanged actuator count.

Inventory the morphology parameters that are allowed to drive leaner/feminine
variants:

```bash
python3 packages/robot/scripts/inventory_asimov1_morphology_parameters.py
```

The catalog defines the current control surface for shell thinning, torso waist
cinch, hip spacing, upper-thigh flare, bust front gain, back arch, calf bulge,
and arm taper. Every parameter lists affected links and the proof types required
before a generated variant can be promoted.

Check whether those morphology parameters are actually safe to expose against
the current proof evidence:

```bash
python3 packages/robot/scripts/validate_asimov1_morphology_parameters.py
```

Use the strict gate when claiming any parameterized leaner/feminine variant is
ready for generation:

```bash
python3 packages/robot/scripts/validate_asimov1_morphology_parameters.py \
  --require-usable
```

That gate is expected to fail until every affected link for every cataloged
parameter has spline-fit, interface, topology, surface-distance, STEP/B-rep, and
MuJoCo load evidence.

Generate a first per-ring spline fit proof for one link:

```bash
python3 packages/robot/scripts/generate_asimov1_spline_fit_proof.py \
  --link LEFT_ANKLE_A \
  --axis z \
  --control-count 64 \
  --max-error-m 0.006 \
  --rms-error-m 0.002 \
  --interface-tolerance-m 0.003 \
  --surface-distance-tolerance-m 0.02
```

This writes `packages/robot/cad/asimov-feminine/proofs/LEFT_ANKLE_A.spline-fit.json`
with one closed cubic B-spline fit per valid cross-section ring plus source-vs-
output attachment slab checks at the reserved connection levels from
`cad/asimov-feminine/param/connections.py`. It also records output STL topology
after quantized vertex merge and a bounded symmetric nearest-vertex
source/output distance. The inventory counts these as spline-fit, interface,
topology, and surface-distance evidence, but it still does not mark the link
`proven_against_step`; that requires the stronger STEP/B-rep and assembly proof.

The default `--section-method slab` samples vertices near each section plane.
For suspected coverage gaps, use exact STL triangle-plane intersections instead.
`plane_intersection` fits a single radial envelope; `plane_loops` fits every
closed contour loop above `--min-loop-perimeter-m` by arc length. The loop
mode records any tiny `--section-nudge-m` fallback used to avoid exact
coplanar triangle-section degeneracy:

```bash
python3 packages/robot/scripts/generate_asimov1_spline_fit_proof.py \
  --link LEFT_SHOULDER_PITCH \
  --section-method plane_loops \
  --control-count 64 \
  --max-error-m 0.006 \
  --rms-error-m 0.002 \
  --interface-tolerance-m 0.003 \
  --surface-distance-tolerance-m 0.02
```

This separates sampler gaps from real profile-model failures. For example, the
single radial exact-section model for `LEFT_SHOULDER_PITCH` exposed one
non-star-shaped cross-section that exceeded tolerance; `plane_loops` now proves
that link by fitting 59 ordered contour loops across 12 section levels. The
current accepted hash-bound reports are `LEFT_SHOULDER_PITCH`, `LEFT_ANKLE_A`,
`RIGHT_ANKLE_A`, `LEFT_HIP_ROLL`, `RIGHT_HIP_ROLL`, `LEFT_SHOULDER_YAW`, and
`RIGHT_SHOULDER_YAW`, `LEFT_WRIST_YAW`, and `RIGHT_WRIST_YAW`. The ankle,
hip-roll, shoulder-yaw, and wrist-yaw reports are
preservation-baseline similarity warps that keep reserved interface slabs inside
tolerance; they are still not STEP/B-rep reconstruction proofs.

Generate or refresh multiple proof reports using each link's configured spine
axis from the connection table:

```bash
python3 packages/robot/scripts/generate_asimov1_spline_fit_proof.py \
  --link LEFT_ANKLE_A \
  --link LEFT_WRIST_YAW \
  --control-count 64 \
  --max-error-m 0.006 \
  --rms-error-m 0.002 \
  --interface-tolerance-m 0.003 \
  --surface-distance-tolerance-m 0.02
```

Use `--all` to attempt all 28 expected links and write the pass/fail reports to
`packages/robot/cad/asimov-feminine/proofs/`.

Summarize whole-robot proof coverage:

```bash
python3 packages/robot/scripts/validate_asimov1_spline_fit_proofs.py
```

Use the strict form when claiming every ASIMOV visual mesh has spline,
interface, topology, and surface-distance proof coverage:

```bash
python3 packages/robot/scripts/validate_asimov1_spline_fit_proofs.py \
  --require-all
```

The strict proof-matrix gate is expected to fail until all 28 links listed in
`cad/asimov-feminine/param/connections.py` have passing proof reports.

Rank the remaining proof failures by the smallest likely repair:

```bash
python3 packages/robot/scripts/rank_asimov1_spline_fit_failures.py --limit 10
```

At the current checkpoint, spline proof reports are SHA-256-bound to the exact
source and output STL bytes; stale proof JSON no longer counts. Under that
stricter gate, 9 of 28 visual mesh links have accepted spline, interface,
topology, and surface-distance proof reports. The remaining 19 failed-attempt
reports include 14 interface failures, 17 topology failures, and 2
surface-distance failures. The all-link refresh uses `plane_loops`, which proves
section fits for the current top repair targets and exposes reserved interface
preservation as the first blocker. `NECK_PITCH` is currently the highest-ranked
repair target because its spline, topology, and surface-distance checks pass but
one reserved interface slab is over tolerance. `RIGHT_HIP_YAW`
remains an inherited-topology target: the source and output both have 7
nonmanifold edges split across 7 manifold face components.

The first `RIGHT_HIP_YAW` repair pass shows that a full clean loft is not enough
by itself: it fixes topology but misses both reserved interfaces and reaches
about 63.5 mm symmetric Hausdorff distance. Local face-removal repair around the
7 nonmanifold edges is infeasible through four face-adjacency expansions, and
generic Trimesh processing preserves the same 7 nonmanifold edges. A
micron-scale component-separation diagnostic can split the 7 shared-edge
contacts, but it does not solve the current reserved interface slab mismatch
against the source mesh. The next repair needs either source-sheet segmentation
or a clean loft with explicit reserved-slab constraints.

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

The promotion plan is schema-versioned (`asimov-1-workspace-promotion-v1`) and
records the source vendor commit plus hashes for the regenerated MJCF, URDF,
asset manifest. It also records the edited source MJCF hash used during
regeneration and promotion. The validator recomputes those hashes and rejects
stale plans whose source edit, generated outputs, destination paths, or
workspace metadata no longer match.

## Simulation And Training

Run the profile simulation gate:

```bash
python3 packages/robot/scripts/sim_validation_gate.py \
  --profile asimov-1 \
  --checkpoint /tmp/asimov-full-training \
  --require-asimov-model-provenance
```

Use a smoke checkpoint without `--require-asimov-model-provenance` only for
local E2E plumbing checks. Full ASIMOV training and release validation must use
the provenance flag so `training_job.json` is checked against the current
generated MJCF and asset manifest hashes.

Create and validate the ASIMOV-1 Brax/MJX PPO baseline job:

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
Brax/MJX PPO path through `run_asimov1_full_training.py`; that runner now
immediately writes verifier evidence with `verify_brax_text_policy.py` and
validates the result with `validate_asimov1_production_checkpoint.py` using the
job's training-step target. Pass `--out /path/full_training_run.json` to archive
a schema-versioned run report; the generated shell wrapper writes
`full_training_run.json` and validates its artifact hashes before running
`eval_text_policy.py --backend mjx` and `sim_validation_gate.py` against the
produced checkpoint with `--require-asimov-model-provenance`. The verifier
writes `inference_check.json`, which is a required production artifact and
records the resolved policy artifact path and SHA-256. The full-training run
validator also requires the archived post-training steps to include
`verify_brax_text_policy.py` and
`validate_asimov1_production_checkpoint.py --require-inference-check` with
parsed passing JSON output. Keep production-scale runs off local developer
machines; use a GPU training host and keep checkpoints out of git.

For the current default continual-learning path, use Alberta:

```bash
cd packages/robot
uv run eliza-robot-train \
  --profile asimov-1 \
  --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right \
  --steps 150000000 \
  --episode-steps 200 \
  --eval-episodes 3 \
  --out checkpoints/asimov_1_alberta_full \
  --seed 0
```

This writes `alberta_policy.npz` plus `manifest.json` with
`regime="alberta_streaming"`. Validate that package with
`eliza-robot-validate-alberta-checkpoint` and the ASIMOV production checkpoint
validator. The Brax/MJX PPO job above remains a baseline/comparison path, not
the default training path.

Smoke checkpoints from `rl/text_conditioned/train.py --smoke` are deterministic
contract artifacts. They verify legacy PPO bridge and policy plumbing but are
not walking policies and are not used by the current ASIMOV E2E gate.

The MJX training environment preserves the Menlo actor observation contract:
45 proprioceptive values plus the text embedding. The proprioceptive joint
position and velocity slices are selected from configurable left/right leg
history buffers (`observation_delay_steps`) so training can model the staggered
bus timing described in Menlo's walking writeup without changing the actor
shape. PPO training uses Brax asymmetric actor/critic observations: the policy
network consumes `state`, while the value network consumes `privileged_state`
with additional simulated base velocity, root height, root angular momentum,
and toe-contact proxy terms.

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
python3 packages/robot/scripts/validate_asimov1_controller_contract.py
python3 packages/robot/scripts/validate_asimov1_policy_loop.py --max-steps 2
python3 packages/robot/scripts/validate_asimov1_server_command_surface.py
```

The controller contract check exercises local mode transitions, velocity
clamping, trajectory width and target validation, watchdog fallback, telemetry
shape, and the generic command aliases that route into ASIMOV controls.
The local controller mirrors the documented hardware API limits: velocity
commands require STAND mode because firmware drops them in DAMP, `vx_mps` is
bounded to +/-2.0 m/s, `vy_mps` to +/-1.0 m/s, `yaw_rad_s` to +/-2.0 rad/s, and
trajectory streaming uses a 200 ms watchdog.

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

The report is schema-versioned (`asimov-1-real-hardware-evidence-v1`). The
validator requires the ordered strict-preflight, telemetry-only, and staged
command stages; confirms telemetry-only published no commands; checks ASIMOV
joint/IMU widths before and after the command probe; requires DAMP to be sent;
and rejects reports where post-command telemetry did not advance.

Validate the real-agent command and policy-loop contract before enabling a
physical robot:

```bash
python3 packages/robot/scripts/validate_asimov1_real_agent_readiness.py \
  --max-steps 2
```

When production checkpoint and hardware evidence are available, require both.
The production checkpoint check also requires the verifier-generated
`inference_check.json` from `verify_brax_text_policy.py`:

```bash
python3 packages/robot/scripts/validate_asimov1_real_agent_readiness.py \
  --checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --require-production \
  --require-hardware
```

The guarded real-agent runner prints a no-motion launch plan unless
`--allow-motion` is supplied. Use it only after production checkpoint
validation, including `inference_check.json`, and hardware evidence validation
pass:

```bash
ASIMOV_LIVEKIT_URL=wss://... ASIMOV_LIVEKIT_TOKEN=... \
python3 packages/robot/scripts/run_asimov1_real_agent.py \
  --checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --task walk_forward \
  --max-steps 100 \
  --out /tmp/asimov-real-agent-run.json
```

To actually connect and command hardware, add `--allow-motion`; without that
flag the script does not connect to LiveKit or publish commands.

Validate and archive the runner report before using it as real-agent evidence:

```bash
python3 packages/robot/scripts/validate_asimov1_real_agent_run.py \
  /tmp/asimov-real-agent-run.json \
  --checkpoint /path/to/asimov-production-checkpoint \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --require-allow-motion \
  --require-motion
```

The `--checkpoint` and `--hardware-evidence` arguments are optional when the
archive is being validated in place: the validator resolves the paths recorded
inside `run_evidence` and still checks that the files exist and match the
recorded hashes. Pass the arguments in completion gates to prove the archived
report is bound to the exact final checkpoint and hardware evidence selected
for release.

For preflight review, omit `--allow-motion` and keep `--out`; that writes a
no-motion launch plan, but the validator rejects it when `--require-motion` is
set.

The runner report records SHA-256 hashes for the production checkpoint
`manifest.json`, checkpoint `inference_check.json`, the checkpoint policy
artifact, and hardware evidence JSON. The validator recomputes those hashes and
re-runs the production checkpoint and real-hardware evidence validators, so a
stale run report fails if it is paired with a different checkpoint, policy, or
hardware evidence file later, or if either referenced artifact no longer
satisfies the current production contract.
For Alberta production checkpoints, the runner also archives the production
checkpoint validator summary. That summary must include the ASIMOV model and
asset-manifest provenance checks, so the real-agent report preserves evidence
that the checkpoint was validated against the generated MuJoCo assets.

## End-To-End Gate

Run the full integration gate:

```bash
python3 packages/robot/scripts/validate_asimov1_e2e.py \
  --out /tmp/asimov-e2e \
  --steps 2
```

This covers source inventory, generated assets, CAD edit regeneration, a tiny
Alberta checkpoint through the default trainer, full-training readiness,
exported runner checks, the tiny Brax/MJX baseline validation package,
MuJoCo/MJX gates, bridge targets, real-agent readiness, real-mode
dry-run/preflight, and the live audit for released ASIMOV model artifacts.

The released-model audit checks the pinned `asimov-1` checkout, discovered
`asimovinc` GitHub repositories, releases, and repository trees. It records
current ASIMOV manual/news sources, including public claims about base walking
or pre-trained policies, separately from downloadable model artifacts. As of
the latest local audit, public ASIMOV sources document training and policy
behavior but no downloadable checkpoint, weights, or policy artifact was found;
`asimovinc/asimov-mjlab` is treated as public training/reference code, not a
released model.

The tiny Brax/MJX job proves baseline integration only; it is not production
walking evidence. Once a real Alberta training run has produced
`alberta_policy.npz` and `manifest.json`, validate the checkpoint package with
an explicit training-step threshold. For Alberta, the production validator
delegates to `validate_alberta_robot_checkpoint.py`, requires the ASIMOV
profile/task/action/output contract, and can run a live inference check. For a
Brax/MJX PPO baseline checkpoint, it still requires the serialized ASIMOV actor
shape, asymmetric critic keys, task set, left/right leg
`observation_delay_steps` contract, and verifier output used by the MJX
trainer. With `--require-inference-check`, stale verifier reports are rejected
for Brax/MJX and Alberta checkpoints must pass the Alberta inference check.

```bash
python3 packages/robot/scripts/validate_asimov1_production_checkpoint.py \
  /path/to/asimov-production-checkpoint \
  --min-steps 150000000 \
  --require-inference-check

python3 packages/robot/scripts/validate_asimov1_full_training_run.py \
  /path/to/asimov-production-checkpoint/full_training_run.json \
  --job-dir /path/to/asimov-production-checkpoint
```

`validate_asimov1_full_training_run.py` is the strict Brax/MJX baseline run
validator. It recomputes hashes for `training_job.json`,
`manifest.template.json`, `policy_brax.pkl`, `manifest.json`, `metrics.json`,
`config.json`, and `inference_check.json`; it also rejects reports whose
archived post-training commands skipped the verifier or production checkpoint
validation. Alberta production checkpoints are validated through
`validate_asimov1_production_checkpoint.py` and real-agent readiness/run gates;
the final completion gate accepts Alberta checkpoints without requiring Brax
sidecars that do not exist.

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
  --full-training-run /path/to/asimov-production-checkpoint/full_training_run.json \
  --real-hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --real-agent-run /tmp/asimov-real-agent-run.json
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
same production checkpoint, hardware evidence, and real-agent run report,
confirms the parsed real agent readiness report was `production_ready`, then
validates the artifacts again with production inference-check, full-training
run, and motion-run evidence required:

```bash
python3 packages/robot/scripts/validate_asimov1_completion.py \
  --e2e-report /tmp/asimov-e2e/asimov1_e2e_report.json \
  --production-checkpoint /path/to/asimov-production-checkpoint \
  --production-min-steps 150000000 \
  --full-training-run /path/to/asimov-production-checkpoint/full_training_run.json \
  --hardware-evidence /tmp/asimov-real-hardware/asimov1_real_hardware_evidence.json \
  --real-agent-run /tmp/asimov-real-agent-run.json
```

This command is intentionally strict: it fails unless the final E2E run,
real-agent readiness report, production training artifact, full-training run
report, hardware evidence, and real-agent motion report all refer to the same
ASIMOV-1 integration state, and unless the production checkpoint includes
passing `inference_check.json` verifier output.
