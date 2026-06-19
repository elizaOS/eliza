# Unitree R1 Bodykit Design Rework Plan

Date: 2026-05-23

## Problem

The first bodykit pass used freehand primitives. That was useful for proving the
MuJoCo/export/test harness, but it does not match the Eliza reference images and
does not respect the original Unitree R1 plastic/mechanical forms closely
enough.

## Current Correction

- The open human-generator Blender extension is installed into Blender's local
  `user_default` extension repo.
- `scripts/generate_eliza_human_donor_blender.py` creates a parametric donor
  face using addon targets, exports:
  - `cad/source-assets/human-donor/eliza_face_donor.stl`
  - `cad/source-assets/human-donor/eliza_face_donor.obj`
  - `cad/source-assets/human-donor/eliza_face_donor.glb`
  - `review/eliza-face-donor.png`
- `bodykit_params.yaml` now uses `shape: donor_face_grid_loft` for
  `face_shell`.
- STEP export now covers all current bodykit parts; the face still needs
  surface-class review and final production DFM before tooling release.
- `scripts/analyze_unitree_r1_oem_envelopes.py` writes
  `review/oem-envelope-audit.json`, grouping the original Unitree R1 STL meshes
  by shell region and flagging non-watertight meshes that need voxel/SDF offset
  instead of direct CAD booleans.
- The bodykit generator now supports explicit loft-section shells for the major
  body regions, replacing the earlier mesh-hull prototype path for the current
  generated bodykit while keeping the donor face blocked until production CAD
  exists.

## Next Modeling Pass

1. Refine OEM R1 envelope sources per moving link from:
   - `head_yaw_link.STL`, `head_pitch_link.STL`
   - `waist_yaw_link.STL`, `waist_roll_link.STL`, `torso_collision.stl`
   - `pelvis_link.STL`
   - shoulder, elbow, wrist, hip, knee, and ankle meshes
2. Replace prototype convex hulls with offset keepout meshes:
   - inner chassis keepout: OEM visual/collision mesh plus 8 mm
   - dynamic keepout: adjacent swept links plus 18 mm
   - outer style envelope: keepout plus wall/visual bulge
3. Convert torso, pelvis, shoulder, arm, thigh, and shin prototype hulls into
   smoothed production surfaces derived from those envelopes.
4. Split every shell by link ownership; no hard plastic part should bridge a
   moving joint unless explicitly marked flexible.
5. Sculpt the human donor face into a hard front faceplate instead of a raw head
   crop. Hair is out of scope for the hard-plastic bodykit and can be handled
   later as a removable wig.

## Validation Gates To Add

- Per-part `source_kind`, `source_asset`, `oem_baseline_meshes`, and mount-body
  provenance.
- Same-link inner clearance against OEM visual meshes, not just non-mounted
  collision clearance.
- Multi-joint pose grid sweeps for shoulders, hips, knees, waist, and head.
- Pairwise bodykit panel gap check targeting 2.5 mm.
- Watertight/manifold checks for any part claiming print-ready hard shell.
- Debug OBJ/GLB export for worst clearance or penetration cases.

## Tooling Status

- Blender 4.5.10 LTS is installed locally under `.tools/blender`.
- The human-generator extension source is staged under `.tools/` and installed
  into the Blender user extension repo.
- CadQuery works locally for primitive STEP export, but it cannot be added as a
  normal package dependency yet because the robot package pins `numpy<2`.
