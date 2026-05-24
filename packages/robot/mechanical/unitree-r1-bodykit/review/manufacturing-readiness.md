# Unitree R1 Bodykit Manufacturing Readiness

Parts: 71
Fit verdict: pass
Simulator verdict: pass
Production clearance verdict: pass
Panel gap verdict: pass
Face alignment verdict: pass
Parametric morphs applied: 38
Minimum adjacent-interface clearance: 0.743 mm
Minimum neck/head/face adjacent-interface clearance: 68.034 mm
Minimum neck/head/face non-adjacent clearance: 297.955 mm
Minimum static non-adjacent clearance: 69.801 mm
Minimum operating dynamic non-adjacent sweep clearance: 30.973 mm
Minimum mechanical dynamic non-adjacent sweep clearance: 1.485 mm
Clearance sampling: deterministic_vertices_and_face_centroids
Articulated body distance: 3
Operating sweep fraction: 0.25
Mechanical sweep fraction: 0.65

Prototype: export STL/OBJ parts in `out/meshes/` for FDM service quoting.
Production: preliminary STEP solids are in `out/step/`, but tool release still requires final R1 CAD/scan, shell offsets, mounts, ribs, inserts, parting lines, and production surfacing.

DFM rules encoded:
- print wall >= 2.4 mm
- molded wall >= 2.0 mm
- draft >= 2.0 deg
- panel gap target 2.5 mm
- shrink allowance 0.6%

Open release gaps:
- STEP export status: exported (71/71 parts).
- STEP blocked parts: 0.
- Design source audit: pass (54 shell parts checked).
- Parametric reconstruction audit: pass (0 shell primitives still need loft reconstruction).
- Panel gap validation: pass (0 sampled nearby pairs below their seam/articulation gate).
- Worst adjacent/interface clearance: {"base_body": "left_shoulder_yaw_link", "base_geom": "geom_107", "base_geom_type": "mesh", "base_sample_point_m": [0.08041, 0.13863, 0.77384], "body_tree_distance": 1, "clearance_mm": 0.743, "part": "left_forearm_outer_blade", "part_body": "left_elbow_link", "part_sample_point_m": [0.08069, 0.13882, 0.7745], "part_to_base_vector_m": [-0.00028, -0.0002, -0.00066], "part_to_base_vector_mm": [-0.285, -0.195, -0.658]}.
- Worst non-adjacent static clearance: {"base_body": "left_shoulder_yaw_link", "base_geom": "geom_107", "base_geom_type": "mesh", "base_sample_point_m": [0.03551, 0.10323, 0.75048], "body_tree_distance": 5, "clearance_mm": 69.801, "part": "pelvis_front_shell", "part_body": "pelvis", "part_sample_point_m": [0.024, 0.042, 0.719], "part_to_base_vector_m": [0.01151, 0.06123, 0.03148], "part_to_base_vector_mm": [11.509, 61.229, 31.477]}.
- Worst operating non-adjacent dynamic pose: right_shoulder_yaw_joint_high.
- Worst mechanical non-adjacent dynamic pose: right_shoulder_pitch_joint_low__right_elbow_joint_low.
- Production fit clearance is a hard gate; visual-only MuJoCo loading is not production clearance evidence.
- Collision-test MJCF is generated for inspection, but final release still needs simplified proxy collision meshes.
- Final production fit needs real R1 mechanical CAD or a scan of the target chassis.

Generated layout/DFM files:
- `shapeways-print-layout.csv`
- `injection-molding-dfm.json`
- `step-export-report.json`
- `design-source-audit.json`
- `parametric-reconstruction-audit.json`
- `base-cad-reconstruction-report.json`
- `panel-gap-validation.json`
- `part-review-report.json`
- `subassembly-volume-report.json`
- `face-alignment-validation.json`
- `mechanical-stress-blockers.json`
- `head-keepout-policy.json`
- `parametric-morph-report.json`
- `render-validation.json` when renders are generated
- `reference-validation.json`
