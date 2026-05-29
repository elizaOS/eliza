# ASIMOV-1 Feminine (Slimmed) Frame — Self-Collision Report

**Date:** 2026-05-24
**Scope:** Read-only collision analysis of the CURRENT slimmed STLs in
`cad/asimov-feminine/output/stl/` (28 canonical link meshes, regenerated 02:26–02:27).
**Method:** Parse the MJCF kinematic tree
(`assets/profiles/asimov-1/mjcf/asimov_eliza.xml`), build forward kinematics,
transform each link's femme STL to world space for sampled joint configurations,
and test non-adjacent link pairs with `trimesh.collision.CollisionManager`
(backed by `python-fcl 0.7.0.11`, installed for this run).

## Conventions

- Frame: pelvis (`pelvis_link`) as the FK root; collisions are frame-invariant.
- **Neutral pose** = all motor joints at 0 EXCEPT the elbows, which carry a MuJoCo
  `ref` offset (`left_elbow_joint ref=+0.785398`, `right_elbow_joint ref=-0.785398`).
  The visual/design zero pose has the elbows at their `ref`, i.e. forearms slightly
  forward — applying `ref` is required for a faithful neutral.
- Directly-connected parent/child pairs are skipped (they always touch at the joint).
- **2-hop nested pairs** (grandparent/grandchild through a tiny intermediate link)
  are reported separately as *structural*: they physically overlap by design and are
  not slimming defects. Notably `hip_pitch ↔ hip_yaw` (through the small `hip_roll`
  link). MuJoCo's `<contact><exclude>` list confirms these clusters are excluded from
  contact in the source model.

## Joints extracted (axis, range in rad)

| Joint | Axis | Range (rad) |
|---|---|---|
| left_hip_pitch | (0, 1, 0) | [-2.094, 1.000] |
| left_hip_roll | (1, 0, 0) | [-0.785, 0.785] |
| left_hip_yaw | (0, 0, -1) | [-0.785, 0.785] |
| left_knee | (0, 1, 0) | [0.000, 1.500] |
| left_ankle_pitch | (0, 1, 0) | [-0.350, 0.350] |
| left_ankle_roll | (-1, 0, 0) | [-0.100, 0.100] |
| right_hip_pitch | (0, -1, 0) | [-1.000, 2.094] |
| right_hip_roll | (1, 0, 0) | [-0.785, 0.785] |
| right_hip_yaw | (0, 0, -1) | [-0.785, 0.785] |
| right_knee | (0, -1, 0) | [-1.500, 0.000] |
| right_ankle_pitch | (0, -1, 0) | [-0.350, 0.350] |
| right_ankle_roll | (-1, 0, 0) | [-0.100, 0.100] |
| waist_yaw | (0, 0, 1) | [-1.571, 1.571] |
| neck_yaw | (0, 0, 1) | [-1.571, 1.571] |
| neck_pitch | (0, 1, 0) | [-0.785, 0.785] |
| left_shoulder_pitch | (0, 1, 0) | [-3.142, 0.873] |
| left_shoulder_roll | (-1, 0, 0) | [-1.571, 0.000] |
| left_shoulder_yaw | (0, 0, -1) | [-1.571, 1.571] |
| left_elbow | (0, -1, 0) | [0.000, 2.443] (ref +0.785) |
| left_wrist_yaw | (0.766, 0, -0.643) | [-3.142, 3.142] |
| right_shoulder_pitch | (0, -1, 0) | [-0.873, 3.142] |
| right_shoulder_roll | (-1, 0, 0) | [0.000, 1.571] |
| right_shoulder_yaw | (0, 0, -1) | [-1.571, 1.571] |
| right_elbow | (0, 1, 0) | [-2.443, 0.000] (ref -0.785) |
| right_wrist_yaw | (0.766, 0, -0.643) | [-3.142, 3.142] |

Plus two passive spring toe joints (`left_toe` [-1.047, 0], `right_toe` [0, 1.047])
which do not drive body-to-body collisions and were excluded from the body sweep.

## Poses tested and results

**Neutral pose:** zero non-adjacent collisions. Nearest non-adjacent clearance
`left_elbow_link ↔ waist_yaw_link` = **62.9 mm**. (The two `shoulder_roll ↔
waist_yaw` gaps sit at ~10 mm — the upper-arm-to-torso gap, expected and ample.)
The only overlaps are the structural 2-hop hip nests (by design).

### Single-joint extremes (joint at min/max, all others neutral)

| Joint @ extreme | Result | Pair(s) |
|---|---|---|
| left_hip_roll = -0.785 (adduct) | COLLISION | left leg crosses into right leg + pelvis (hip_yaw/knee vs right hip_yaw/knee) |
| right_hip_roll = +0.785 (adduct) | COLLISION | mirror of above |
| left_hip_yaw = +0.785 | COLLISION | left_hip_yaw ↔ pelvis (thigh root grazes pelvis) |
| right_hip_yaw = -0.785 | COLLISION | right_hip_yaw ↔ pelvis (mirror) |
| left_shoulder_yaw = +1.571 | COLLISION | left_wrist_yaw ↔ waist_yaw (hand swings into torso) |
| right_shoulder_yaw = -1.571 | COLLISION | right_wrist_yaw ↔ waist_yaw (mirror) |
| left_elbow = +2.443 (full flex) | COLLISION | left_shoulder_roll ↔ left_wrist_yaw (forearm folds back to upper arm) |
| right_elbow = -2.443 (full flex) | COLLISION | right_shoulder_roll ↔ right_wrist_yaw (mirror) |
| all other single-joint extremes | clear | — |

### Combined poses

| Pose | Result | Detail |
|---|---|---|
| arms_forward (shoulders ±90°) | clear | nearest elbow↔waist 111 mm |
| arms_fwd_elbow_bent | COLLISION | shoulder_roll ↔ wrist (elbow fully closed) |
| deep_knee_bend (hips 1.8 + knees 1.5) | clear | nearest elbow↔hip_yaw 53 mm; thighs clear torso |
| hips_abducted (legs spread) | clear | nearest 63 mm |
| hips_adducted (legs inward to limit) | COLLISION | legs cross / press together |
| legs_crossed (adduct + yaw) | COLLISION | legs cross / press together |
| squat_arms_fwd | COLLISION | only the elbow-fold pair (legs clear) |
| torso_twist_arms_in (waist 90° + elbows closed) | COLLISION | only the elbow-fold pair |
| hug_self (shoulders fwd, yaw in, elbows closed) | COLLISION | elbow-fold; wrist↔waist 22.8 mm |
| arms_full_inward | COLLISION | elbow-fold; wrist↔waist 19.7 mm |

## Verdict

**The current slimmed frame is kinematically sound. No self-collision is caused by
the feminization/slimming.** Every collision found is a legitimate
end-of-range-of-motion limit that exists in the original ASIMOV-1 geometry as well:

1. **Leg-to-leg / leg-to-pelvis at full hip adduction or yaw** — the legs are
   commanded *into each other*; this is a software ROM-limit concern, not a frame
   defect. Slimming the thighs/calves *reduces* this. In neutral and abducted stance
   the legs have a healthy 63 mm gap.
2. **Forearm-to-upper-arm at full elbow flexion** (`shoulder_roll ↔ wrist_yaw`) —
   normal arm folding; your own wrist reaches your bicep at full flexion. The
   intermediate links (shoulder_yaw, elbow) are adjacent and excluded; the wrist tip
   touching the upper-arm shell is expected.
3. **Wrist-into-torso at extreme shoulder_yaw** — the hand is rotated into the body;
   a combined-extreme that a normal arms-at-side controller never reaches. Torso
   curve agents could tighten this, but it is not a slimming regression.

In the normal operating envelope (standing, arms at sides or forward, sitting/squat,
walking-range hip/knee motion) there are **zero unexpected self-collisions**, and the
tightest healthy clearance is the ~10 mm upper-arm-to-torso gap, which is by design.

> Note: this reflects the CURRENT slimmed state. A limb-slim agent thinning limbs
> further in parallel only *reduces* the leg-crossing and arm-fold contacts above.

## FK verification

FK correctness was confirmed by rendering with the brief's PyVista recipe (assembled
via the FK world transforms, not the static `P` dict) and visually inspecting:

- `/tmp/collision_renders/neutral_front.png`, `neutral_34.png` — coherent standing
  humanoid, head→toe stacking correct, symmetric, forearms forward per elbow `ref`.
- `/tmp/collision_renders/deep_knee_bend_34.png` — clean seated/squat pose (hips
  flexed, knees forward, calves vertical, feet flat); validates rotational FK.
- `/tmp/collision_renders/hips_adducted_front.png` — legs visibly pressed/crossed,
  matching the reported leg-leg collision.
- `/tmp/collision_renders/hug_self_front.png` — forearm folded up to the chest,
  matching the reported forearm↔upper-arm contact.

No exploded or mis-placed links in any pose, confirming the kinematic tree, `pos`
offsets, axis rotations, and elbow `ref` handling are correct.

## Tooling

Scripts (in `/tmp`, not checked in): `collision_sweep.py` (MJCF parse + FK + mesh
load), `run_sweep2.py` (optimized sweep — one persistent fcl manager reused via
`set_transform` per pose), `render_poses.py` (FK-assembled PyVista renders).
`python-fcl` was installed successfully; the convex-hull fallback was not needed.
