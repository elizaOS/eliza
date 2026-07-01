# Arms / Shoulders / Wrists Bodykit Pass

Date: 2026-05-23

Scope owned in this pass:

- Shoulder caps
- Upper-arm shells and blades
- Forearm shells, blades, and detail strips
- Wrist cuff/index geometry

Parameter changes:

- Shoulder caps are smaller orange OEM-envelope armor caps.
- Upper arms are now slim black mechanical sleeves with separate orange outer blades.
- Forearms are now shorter black mechanical sleeves trimmed away from the wrist roll link, with separate orange forearm blades and inner black detail strips.
- Wrist cuffs are separated from the wrist roll link and represented as slim forearm-end collars, leaving the moving OEM wrist roll link clear.

Measured generated mesh extents:

| Part | Before extents XYZ (mm) | After extents XYZ (mm) | Impact |
| --- | ---: | ---: | --- |
| `left_shoulder_cap` | 92.5 x 119.7 x 126.6 | 69.2 x 86.6 x 98.1 | smaller cap, about 25-28 mm narrower on each major envelope axis |
| `right_shoulder_cap` | 92.6 x 119.7 x 126.6 | 69.2 x 86.6 x 98.1 | symmetric smaller cap |
| `left_upper_arm_shell` | 97.9 x 85.3 x 140.5 | 60.5 x 47.6 x 104.4 | slimmer black sleeve, orange moved to blade |
| `right_upper_arm_shell` | 97.8 x 84.8 x 140.5 | 60.4 x 47.4 x 104.4 | symmetric slimmer black sleeve |
| `left_forearm_shell` | 161.3 x 85.5 x 88.7 | 70.9 x 47.5 x 54.8 | trimmed off wrist-roll source; shorter slimmer forearm sleeve |
| `right_forearm_shell` | 161.2 x 85.5 x 88.8 | 70.9 x 47.5 x 54.8 | symmetric shorter slimmer forearm sleeve |
| `left_wrist_separated_cuff` | n/a | 5.0 x 32.4 x 32.4 | new separated slim forearm-end cuff |
| `right_wrist_separated_cuff` | n/a | 5.0 x 32.4 x 32.4 | new separated slim forearm-end cuff |

Targeted arm-only clearance sweep:

- Command shape: generated meshes and MJCF from `bodykit_params.yaml`, then ran `_joint_sweep_report` against only parts containing `shoulder`, `upper_arm`, `forearm`, or `wrist`.
- Operating sweep fraction: 0.25.
- Mechanical stress sweep fraction: 0.65.
- Articulated body distance: 3.

Results:

- Operating arm-only non-adjacent clearance: 41.205 mm minimum; no arm-owned pose below the 18 mm dynamic target.
- Mechanical arm-only non-adjacent clearance: 4.264 mm minimum in `left_shoulder_yaw_joint_low`, with `right_forearm_shell` near the OEM `left_wrist_roll_link`.
- Previous mechanical arm-owned blockers in the stale full-fit report included `left_forearm_shell` at 0.678 mm in `left_shoulder_yaw_joint_low` and `right_forearm_shell` at 2.173 mm in `right_shoulder_pitch_joint_low__right_elbow_joint_low`; the worst arm-owned stress clearance improved to 4.264 mm, but still does not pass the 18 mm mechanical stress target.

Panel-gap impact:

- Current panel-gap validator result after this params pass: `pass`.
- Pairs checked: 145.
- Pairs below gate: 0.
- Minimum sampled panel gap: 1.149 mm at an articulated arm interface.
- Arm-owned near gaps are above their gates:
  - `left_upper_arm_outer_blade` to `left_forearm_shell`: 1.149 mm against 1.0 mm articulation gate.
  - `right_upper_arm_outer_blade` to `right_forearm_shell`: 1.498 mm against 1.0 mm articulation gate.
  - `right_upper_arm_shell` to `right_forearm_shell`: 1.968 mm against 1.0 mm articulation gate.
  - `left_upper_arm_shell` to `left_forearm_shell`: 2.364 mm against 1.0 mm articulation gate.

Full generator / fit validation:

- Command completed with `--skip-render --skip-video` and thread limits.
- Simulator verdict: `pass`.
- Production clearance verdict: `needs-work`.
- Static non-adjacent clearance: 49.422 mm, above the 8 mm static target.
- Operating dynamic non-adjacent clearance: 2.077 mm in `left_shoulder_pitch_joint_high__left_elbow_joint_high`, still below the 18 mm target but improved from the prior 0.885 mm pelvis-to-left-wrist blocker.
- Mechanical dynamic non-adjacent clearance: 0.242 mm in `right_hip_yaw_joint_low__right_knee_joint_low`, now dominated by foot/ankle geometry outside this arms-only scope.
- Face-to-wrist mechanical stress blockers improved from the prior 0.284 mm right eye/wrist case to 0.818 mm left face/wrist and 0.875 mm right face/wrist, but remain below target.

Final merged validation after the later foot/leg/torso/head integration pass:

- Static non-adjacent clearance: 50.483 mm.
- Operating dynamic non-adjacent clearance: 6.7 mm in `right_shoulder_pitch_joint_high__right_elbow_joint_high`, still below the 18 mm target.
- Mechanical dynamic non-adjacent clearance: 0.176 mm in `right_hip_yaw_joint_low__right_knee_joint_low`, still below the 18 mm target.

Remaining blockers not masked:

- The full production clearance gate remains `needs-work`; final merged operating dynamic clearance is 6.7 mm versus the 18 mm target.
- The current operating blocker is still `pelvis_front_shell` near the OEM `left_wrist_roll_link`; this is a pelvis bodykit part versus the bare OEM wrist roll link, not an arm shell collision.
- The current mechanical blocker is foot/ankle geometry outside this arms-only scope.
- Face shell proximity to the OEM wrist roll links remains below the 18 mm target in the mechanical stress sweep.
- Mechanical stress sweep for arm-owned parts improved but remains below the 18 mm target.
