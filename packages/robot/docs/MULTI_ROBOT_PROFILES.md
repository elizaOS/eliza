# Multi-Robot Profiles

`eliza_robot` is profile-driven. Every code path that touches a robot — sim
env loaders, RL trainers, bridge backends, perception adapters, the TS
plugin — resolves robot-specific configuration from a `RobotProfile` keyed
by `profile_id`. No hardcoded `if robot == "ainex"` branches.

## Where things live

```
packages/robot/
  eliza_robot/profiles/
    schema.py         # Pydantic v2 RobotProfile model + loader
    __init__.py       # load_profile, list_profiles, DEFAULT_PROFILE_ID
  profiles/
    <id>/profile.yaml # one manifest per robot
  assets/profiles/
    <id>/             # heavy binary assets (MJCF/MJX/URDF/STL)
```

The TS mirror types live in `plugins/plugin-ainex/src/types.ts` and the
Zod schemas in `plugins/plugin-ainex/src/profile-schema.ts`. The Python
schema is the source of truth — keep the TS side in lockstep.

## What a profile contains

| Section | Purpose |
|---|---|
| `id`, `name`, `version`, `description` | Identity + provenance. |
| `kinematics` | DoF count + per-joint `JointSpec` (name, index, limits, home, group, actuator torque, velocity max). Index = position in the actuator vector. |
| `gait` | Locomotion baseline: `cycle_hz`, `swing_height_m`, `stance_width_m`, `step_length_max_m`, `foot_offset_m`, `default_height_m`, and the controller flavour (`bezier` / `rl` / `openpi`). |
| `sensors` | IMU noise std + list of `CameraSpec` (resolution, fps, FoV, mount link, extrinsics). |
| `control` | Outer-loop rate, command smoothing, per-step joint delta cap, hard torque clip. |
| `assets` | Paths to MJCF, MJX, URDF, mesh directory — relative to `assets/profiles/<id>/`. Loader resolves to absolute paths. |
| `actions` | Named scripted gestures (`stand`, `sit`, `wave`, `bow`, …) as timed keyframe sequences. |
| `safety` | Fall thresholds (pitch/roll), low-battery cutoff, deadman timeout. |
| `bridge_capabilities` | Subset of bridge `VALID_COMMANDS` this profile supports. Plugins MUST refuse commands not listed. |

## Why MJCF, MJX, and URDF are all listed

Different consumers need different formats:

- `mjcf_xml` — the canonical MuJoCo XML. Used for CPU rollouts, rendering,
  manual scene inspection, and the `mujoco` viewer. **Any code that
  instantiates a MuJoCo env MUST read this path from
  `RobotProfile.assets.mjcf_xml`.** Hardcoding a path is a profile-bypass
  bug.
- `mjx_xml` — the MJX-optimised variant (primitive collisions, GPU-friendly
  shapes). Used by Brax-PPO training and batched MJX rollouts. Often
  derived from the MJCF by stripping mesh collisions, but kept as a
  separate file because the optimised form is not always round-trippable.
- `urdf` — the URDF the robot ships with. Required by IsaacLab / IsaacSim,
  ROS toolchains, motion planners, RViz, and any consumer that does not
  speak MuJoCo. Source of truth for kinematics; the MJCF/MJX are derived
  from it.

The profile pins **paths**, not file contents — drop the actual assets
into `assets/profiles/<id>/` and update the YAML if you rename them.

## How to add a new profile (e.g. Unitree H1, custom arm)

1. Pick a stable `id` (lowercase, dashes): `unitree-h1`, `xarm-7`,
   `koch-arm-v1`.
2. Create `packages/robot/profiles/<id>/profile.yaml`. Start by copying
   `hiwonder-ainex/profile.yaml` and editing in place. The schema is
   strict — `extra="forbid"` will reject typos and unknown fields.
3. Fill in `kinematics.joints` from the robot's URDF/MJCF. Indices must be
   a contiguous `0..N-1` permutation; names must be unique. Group each
   joint as `LEG`, `ARM`, or `HEAD` (arm-only robots use `ARM` for
   everything, optionally with a virtual `HEAD` group if there is a
   camera gimbal).
4. Drop the assets into `packages/robot/assets/profiles/<id>/`:
   - `ainex.xml` (or `<robot>.xml`) — MJCF
   - `ainex_mjx.xml` — MJX variant (can equal the MJCF if no special
     optimisation is needed)
   - `ainex.urdf` — URDF
   - `meshes/` — STL/OBJ files referenced by the XMLs/URDF
   Point the `assets:` block in the YAML at these filenames.
5. Pick a `gait.controller`:
   - `bezier` — hand-tuned cubic-Bezier gait (Hiwonder/OP3 style). Good
     baseline for biped/humanoid.
   - `rl` — Brax-PPO learned policy. Required if you trained a custom
     joystick policy for this robot.
   - `openpi` — defer to a Physical Intelligence VLA backend over HTTP.
     Used for manipulation-heavy embodiments.
   For arm-only robots, `bezier`/`rl` still apply but the gait params are
   effectively unused; set them to reasonable conservative values and rely on
   `bridge_capabilities` to gate which commands are exposed.
6. Set `bridge_capabilities` to the subset of bridge commands this robot
   actually supports. An arm without legs should not list `walk.set` /
   `walk.command`. The bridge will reject commands not in this set.
7. Add a test in `packages/robot/tests/test_profiles.py` that loads the
   new profile and asserts its basic invariants (DoF count, group counts,
   asset files exist when populated).
8. (Optional) Register the profile in the runtime `DEFAULT_PROFILE_ID`
   only if it should be the user-visible default; otherwise leave it
   discoverable via `list_profiles()`.

## Contract for asset consumers

Any module that loads MuJoCo XMLs — env wrappers, render helpers,
trajectory players, smoke tests — MUST go through the profile:

```python
from eliza_robot import load_profile

profile = load_profile("hiwonder-ainex")
mj_model = mujoco.MjModel.from_xml_path(str(profile.assets.mjcf_xml))
```

The same applies to MJX and URDF consumers:

```python
mjx_model = mjx.put_model(
    mujoco.MjModel.from_xml_path(str(profile.assets.mjx_xml))
)
```

```python
articulation = ArticulationCfg(usd_or_urdf=str(profile.assets.urdf))
```

A grep for `"ainex.xml"`, `"ainex_mjx.xml"`, or hardcoded paths under
`assets/profiles/` outside `schema.py` is a bug.

## Drift between Python and TS

The TS mirror in `plugins/plugin-ainex/src/types.ts` exists so the
ElizaOS plugin can validate and use the same shape without re-deriving
it. Any field added/removed/renamed in `schema.py` MUST be applied to:

- `plugins/plugin-ainex/src/types.ts` — type-level mirror
- `plugins/plugin-ainex/src/profile-schema.ts` — Zod parser
- the hardcoded `HIWONDER_AINEX_FALLBACK` (until the bridge ships
  `profile.describe`)

`packages/robot/tests/test_profiles.py` and
`plugins/plugin-ainex/test/profile.test.ts` are the safety net.
