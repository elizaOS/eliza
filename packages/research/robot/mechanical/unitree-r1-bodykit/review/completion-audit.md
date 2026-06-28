# Unitree R1 Bodykit Completion Audit

Date: 2026-05-23

## Current Evidence

- R1 profile exists: `profiles/unitree-r1/profile.yaml`.
- Official R1 MJCF/STLs are vendored from Unitree's `unitree_mujoco` source:
  `vendor/unitree_mujoco/unitree_robots/r1/`.
- MuJoCo bodykit model exists: `out/mjcf/R1_C++_bodykit.xml`.
- MuJoCo collision-inspection model exists:
  `out/mjcf/R1_C++_bodykit_collision_test.xml`.
- Prototype meshes exist: `out/meshes/*.stl`, `out/meshes/*.obj`.
- Preliminary parametric STEP solids exist: `out/step/*.step`.
- Current parametric bodykit contains 69 generated parts, including lofted
  parametric replacements for the previous OEM-derived torso, pelvis, neck,
  shoulder, upper-arm, forearm, thigh, and shin hulls. It also includes longer
  shallow chest side skins, under-bust black inset, rear back cut lines, rear
  glute armor skins, and a restored right thigh front plate for stronger
  orange/black visual layering. The tiny wrist index accents, abdomen side cuts,
  and knee-panel inserts are now treated as painted or molded-color markings
  rather than raised collision/stress geometry.
- Open human-generator donor face source exists:
  `cad/source-assets/human-donor/eliza_face_donor.stl`.
- The major torso, pelvis, shoulder, arm, thigh, shin, and neck shells now use
  `shape: section_loft` with explicit mathematical sections instead of
  mesh-derived prototype hulls.
- Assembled exchange files exist:
  - `out/unitree-r1-bodykit-assembled-home.obj`
  - `out/unitree-r1-bodykit-assembled-home.glb`
- MuJoCo renders and orbit video exist in `review/`.
- Blender review render and `.blend` scene exist in `review/`.
- Print and molding handoff files exist:
  - `review/shapeways-print-layout.csv`
  - `review/injection-molding-dfm.json`
  - `review/manufacturing-manifest.json`
  - `review/manufacturing-readiness.md`
  - `review/reference-validation.json`
  - `review/render-validation.json`
  - `review/step-export-report.json`
  - `review/panel-gap-validation.json`
  - `review/part-review-report.json`
- OEM envelope audit exists: `review/oem-envelope-audit.json`.
- Sourcing and cost plan exists: `review/sourcing-and-cost-plan.md`.
- Supplied Eliza concept PNG and single-mesh GLB are copied into
  `cad/source-assets/concept/` and validated as current reference evidence.
  The GLB remains a design reference only, not a production source mesh.
- Concept-overlay renders exist for front, side, rear, operating blocker, and
  mechanical blocker review, plus front/side scale overlays.
- Human donor face render exists: `review/eliza-face-donor.png`.

## Latest Validation Results

From `review/fit-validation.json`:

- `verdict`: pass
- `simulator_verdict`: pass
- `clearance_verdict`: pass
- `production_fit_verdict`: pass
- `bodykit_contact_count`: 0
- `clearance_sampling`: deterministic_vertices_and_face_centroids
- `articulated_body_distance`: 3
- `minimum_non_mounted_body_clearance_mm`: 1.575 mm at an adjacent kinematic interface
- `minimum_non_adjacent_body_clearance_mm`: 72.595 mm, above the 8 mm static target
- `worst_non_mounted_body_clearance`: identifies the closest bodykit part,
  mounted body, base geom, base body, and sampled clearance in millimeters.
  Current adjacent-interface minimum: `left_forearm_shell` to
  `left_shoulder_yaw_link` at 1.575 mm.
- `worst_non_adjacent_body_clearance`: current static non-adjacent minimum is
  `right_forearm_outer_blade` to `torso_link` at 72.595 mm.
- `dynamic_joint_sweep.label`: `bodykit_operating`
- `dynamic_joint_sweep.sweep_fraction`: 0.25
- `dynamic_joint_sweep.poses_checked`: 69
- `dynamic_joint_sweep.minimum_non_adjacent_clearance_mm`: 23.835 mm, above the 18 mm target
- `dynamic_joint_sweep.worst_non_adjacent_pose`: `right_shoulder_yaw_joint_high`
- `mechanical_dynamic_joint_sweep.label`: `mechanical`
- `mechanical_dynamic_joint_sweep.sweep_fraction`: 0.65
- `mechanical_dynamic_joint_sweep.minimum_non_adjacent_clearance_mm`: 1.062 mm, below the 18 mm stress target
- `mechanical_dynamic_joint_sweep.worst_non_adjacent_pose`: `right_shoulder_pitch_joint_low__right_elbow_joint_low`
- `dynamic_joint_sweep.pose_results[].worst_clearance`: records the nearest
  base geom/body for each checked pose
- `worst_*_clearance` and stress-blocker rows now include sampled bodykit/base
  closest points and part-to-base vectors for targeted geometry review.
- `bodykit_geoms_are_visual_only`: true
- `collision_test_model_loads`: true

From `review/panel-gap-validation.json`:

- `verdict`: pass
- `pairs_checked`: 118
- `pairs_below_gap_gate`: 0
- `minimum_sampled_panel_gap_mm`: 0.415 mm
- Rigid panel seams use the 2.5 mm nominal gap; articulated interfaces use the
  documented 1.0 mm minimum articulation gate.
- Seated face details use the documented 0.1 mm seated-detail gate; those
  inserts remain included in the mechanical stress clearance sweep.
- The current minimum sampled gap is a seated face-detail interface. The
  smallest articulated interface is the upper-arm/forearm interface at 1.01 mm,
  above its 1.0 mm articulation gate.
- The foot/ankle and leg passes clear the sampled gate. The separated black
  leg underbody and orange armor plates do not appear in the below-gate list.

From `review/part-review-report.json`:

- `verdict`: needs-work
- `bodykit_parts`: 69
- Regions covered: feet/ankles, legs, hips/torso/chest/back, arms, neck/head/face.
- `unclassified_parts`: empty

From `review/step-export-report.json`:

- `status`: exported
- `exported_count`: 69
- `blocked_count`: 0
- `cadquery_version`: 2.7.0
- `face_shell` now exports as `donor_face_grid_loft`, a donor-derived fixed
  `y/z` grid loft rather than an imported production mesh.

From `review/reference-validation.json`:

- `verdict`: pass
- Source PNG and GLB hashes match the copied project assets.
- Reference GLB measured height: 1.89834 m.
- Recorded scale factor to the R1 height envelope: 0.64793.

From `review/render-validation.json`:

- `verdict`: pass
- Required images: 23
- `missing_images`: empty
- `blank_images`: empty

From `review/mechanical-stress-blockers.json`:

- `verdict`: needs-work
- `target_mm`: 18.0
- `minimum_non_adjacent_clearance_mm`: 1.062
- `worst_pose`: `right_shoulder_pitch_joint_low__right_elbow_joint_low`
- `blocker_count`: 9
- Blocker regions: arms, legs, neck/head/face, feet/ankles.
- Current worst blocker: `face_shell` against `right_wrist_roll_link`
  at 1.062 mm in `right_shoulder_pitch_joint_low__right_elbow_joint_low`.
- The narrowed thigh/side-plate pass removed the right-thigh cross-knee stress
  blocker from the current stress list while preserving the panel-gap pass.
- The knee/toe cleanup converted raised knee-panel inserts to markings and
  improved the worst non-head stress row to `left_shin_front_armor` at
  6.886 mm while preserving the panel-gap pass.
- The vector-guided wrist/forearm pass removed the raised wrist-index accents
  from physical geometry, slimmed/moved the left cuff, and reduced the
  left forearm blade; the remaining arm stress rows are
  `left_forearm_outer_blade` at 15.607 mm and `right_forearm_outer_blade` at
  16.378 mm. The right boot outsole pass removed the prior right-foot outsole
  stress row and shifted the current foot stress row to `left_foot_top_shell` at
  14.535 mm. The abdomen inset, abdomen side-cut marking conversion, and
  pelvis-center/front-shell trims removed abdomen/pelvis detail rows from the
  current stress-blocker list while keeping panel gaps above their gates.
- `review/head-keepout-policy.json` is generated from the two face/wrist
  stress rows. It keeps those rows as blockers, but records them as
  head-protection keepout candidates so the donor-derived face is not degraded
  further just to satisfy extreme wrist-roll poses.
- `review/face-alignment-validation.json` now records `face_shell_depth_check`:
  the current donor face proportions pass, and face depth now passes at
  15.380 mm against a 12.0 mm aesthetic minimum after converting the donor
  face into a parametric grid loft while keeping production fit and panel-gap
  gates passing.
- `review/face-alignment-validation.json` also records
  `face_production_surfacing`: `parametric-step-pass` with fixed-grid donor
  sampling metadata and a STEP-exported face shell.

Focused test command:

```bash
cd packages/robot
uv run pytest tests/test_profiles.py tests/test_unitree_r1_bodykit.py -q
```

Expected current result: 47 tests pass.

## Not Claimed Complete

This is not a production tooling release. The current artifact is an EVT
parametric bodykit that exports mesh and near-complete STEP artifacts, loads, renders,
and can be inspected in MuJoCo. The
remaining production blockers are:

- Production clearance now passes the current operating sweep gate:
  deterministic static non-adjacent clearance clears the 8 mm target and the
  operating sweep clears the 18 mm target. This is still not a tooling release:
  the wider mechanical stress sweep remains below 18 mm in
  `right_shoulder_pitch_joint_low__right_elbow_joint_low`, and final CAD
  boolean/proxy-collision checks against the target chassis are still required.
  Detailed stress blockers are
  grouped by region in `review/mechanical-stress-blockers.json`.
- The current part-review gate intentionally remains `needs-work`: every region
  is represented and checked, but the feet, rear hip fairings, chest contour
  plates, and head carrier are still EVT styling geometry rather than final
  sculpted armor.
- Panel-gap sampling is currently `pass` for the generated EVT meshes,
  including the updated foot/ankle parts and separated leg plates. Final
  production gap validation still needs surfaced CAD after real split lines and
  mounting bosses are added.
- STEP solids are preliminary generated loft/primitive envelopes, not final
  molded part design. The donor face still needs a parametric production CAD
  rebuild.
- The imported human donor face is an aesthetic source mesh, not
  production CAD or a moldable shell.
- The collision-test MJCF uses unreduced cosmetic meshes; final release needs
  simplified collision proxies and CAD boolean checks.
- Major shell generation now uses explicit loft sections rather than relying on
  OEM convex-hull trims. Production CAD still needs explicit split surfaces,
  inner offsets, mounts, ribs, and fastening interfaces.
- Final Unitree R1 production CAD or a scan is still required for hard tooling.
- Shell interiors, real mounts, bosses, ribs, inserts, split lines, and texture
  specs are not complete.
- Mold-flow analysis and supplier RFQ are not completed.
- The Blender MCP/plugin was not available in this session; Blender itself was
  installed as a local portable tool at `packages/robot/.tools/blender`.

The project is ready for the next surfacing/CAD pass, not for injection mold
purchase.
