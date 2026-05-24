# ASIMOV Fembot CAD/Simulation Plan

This workspace is the production-oriented successor to the existing
`cad/asimov-feminine` mesh experiment. The target is a thinner ASIMOV-derived
robot, called `fembot`, that preserves ASIMOV height and buildability while
minimizing limb and torso envelopes subject to explicit mechanical,
manufacturing, collision, and physics constraints.

## Located ASIMOV Sources

- Full assembly STEP:
  `packages/robot/vendor/asimov-1/mechanical/ASV1/ASIMOV_V1.STEP`
- Subassembly STEP files:
  `packages/robot/vendor/asimov-1/mechanical/ASV1/{100,200,300,400,500,600,700}/ASV1_*.STEP`
- Per-part fabrication STEP files:
  `packages/robot/vendor/asimov-1/mechanical/ASV1/*/FABRICATION/{ALU_7075,SML_316L,MJF_PA12,OFF_THE_SHELF}/`
- Simulation STL meshes:
  `packages/robot/vendor/asimov-1/sim-model/assets/meshes/*.STL`
- Runtime profile:
  `packages/robot/assets/profiles/asimov-1/`
- MuJoCo authority:
  `packages/robot/assets/profiles/asimov-1/mjcf/asimov_eliza.xml`
- Current parametric experiment:
  `packages/robot/cad/asimov-feminine/`

## Body-Part Grouping

The fembot model should be optimized and validated by five top-level body
groups while still preserving the 28-link ASIMOV kinematic tree.

| Group | ASIMOV links |
| --- | --- |
| Torso | `IMU_ORIGIN`, `WAIST_YAW` |
| Head | `NECK_YAW`, `NECK_PITCH` |
| Arm | `LEFT_SHOULDER_PITCH`, `RIGHT_SHOULDER_PITCH`, `LEFT_SHOULDER_ROLL`, `RIGHT_SHOULDER_ROLL`, `LEFT_SHOULDER_YAW`, `RIGHT_SHOULDER_YAW`, `LEFT_ELBOW`, `RIGHT_ELBOW`, `LEFT_WRIST_YAW`, `RIGHT_WRIST_YAW` |
| Leg | `LEFT_HIP_PITCH`, `RIGHT_HIP_PITCH`, `LEFT_HIP_ROLL`, `RIGHT_HIP_ROLL`, `LEFT_HIP_YAW`, `RIGHT_HIP_YAW`, `LEFT_KNEE`, `RIGHT_KNEE`, `LEFT_ANKLE_A`, `RIGHT_ANKLE_A`, `LEFT_ANKLE_B`, `RIGHT_ANKLE_B` |
| Foot | `LEFT_TOE`, `RIGHT_TOE` |

## Current Evidence Snapshot

Commands run from `packages/robot`:

```bash
python3 scripts/inventory_asimov1_parametric_meshes.py
python3 scripts/validate_asimov1_spline_fit_proofs.py
python3 scripts/inventory_asimov1_morphology_parameters.py
python3 scripts/validate_asimov1_morphology_parameters.py
python3 scripts/rank_asimov1_spline_fit_failures.py --limit 12
python3 scripts/generate_asimov1_mujoco_load_proof.py
python3 scripts/generate_asimov1_collision_sweep_proof.py
python3 scripts/generate_asimov_fembot_material_manufacturing_proof.py
python3 scripts/generate_asimov_fembot_surface_quality_proof.py
python3 scripts/generate_asimov_fembot_keepout_proof.py
python3 scripts/inventory_asimov_fembot.py
python3 scripts/report_asimov_fembot_proof_contracts.py
```

Observed state:

- 28/28 ASIMOV visual meshes have connection specs, part scripts, and generated
  output STLs in the current `asimov-feminine` workspace.
- 28/28 are still classified as `mesh_derived_parametric_unproven`.
- The non-hash-gated proof matrix can see 11 accepted spline-fit/interface/
  topology/surface-distance reports, but the stricter parametric inventory only
  counts 1/28 links whose proof hashes still match the current source and output
  meshes. Treat stale proof reports as advisory diagnostics, not promotion
  evidence.
- 0/28 links are proven against STEP/B-rep.
- 0/8 morphology parameters are currently usable for production generation.
- MuJoCo static proof passes: 28 mesh refs resolve, 25 position actuators match
  firmware order, collision geoms are present.
- MuJoCo dynamic proof passes when run with the package virtualenv:
  `.venv/bin/python scripts/generate_asimov1_mujoco_load_proof.py --require-ok`.
  The model imports, compiles, forwards, and steps with `nu=25`, `nmesh=28`,
  `nbody=29`, `ngeom=62`, `nq=34`, and `nv=33`.
- The baseline collision sweep runs locally through MuJoCo and records neutral
  plus lower/mid/upper samples for each limited hinge joint. Neutral has only
  approved floor/foot contacts, but some joint-limit endpoint samples currently
  produce unapproved self-contacts in hip, neck, and arm poses. This is useful
  fembot evidence: a thinner derivative needs collision-sweep acceptance before
  promotion, either by preserving clearance or by narrowing allowed ranges.
- The fembot production inventory is not ready: 5/5 body groups are missing
  STEP/B-rep or controlled-loft proof, manufacturing proof, flatness/smoothness
  proof, component keepout proof, collision sweep, assembly, structural, and
  visual-review evidence. Dynamic MuJoCo is now available locally through
  `.venv`, but the generated fembot geometry still needs its own accepted
  dynamic proof after fembot meshes/MJCF are produced.
- The proof contract report defines 14 required artifact classes with explicit
  `accepted` fields and minimum evidence fields. A generated fembot body group
  is not promotable until every required proof type has a matching accepted
  artifact.
- Candidate fabrication STEP files are now classified by material/process from
  their source folders (`ALU_7075`, `SML_316L`, `MJF_PA12`, `OFF_THE_SHELF`).
  This proves source classification coverage, but it is not accepted production
  material/manufacturing evidence until generated fembot parts have measured
  wall thickness, flatness/smoothness, tool access, draft/undercut, tolerance,
  mass, and inertia records.
- Source STL surface-quality measurement now runs for 28/28 links and records
  largest planar patch flatness plus adjacent normal-angle discontinuity for
  each mesh. This is useful baseline evidence for deciding which surfaces must
  stay flat versus smooth, but it is not accepted production flatness/
  smoothness evidence until generated fembot STEP/loft surfaces exist with
  material/process tolerances and identified surface zones.
- Component keepout inventory now extracts MJCF joint axes, position actuators,
  collision capsules, foot sites, source mesh envelopes, and off-the-shelf
  vendor STEP envelopes. Current counts are 27 joint keepouts, 25 actuator
  keepouts, 33 collision keepouts, 4 site keepouts, 28 source mesh envelopes,
  and 105 body-group vendor-envelope references. This is not accepted
  production keepout proof until generated fembot geometry reports positive
  clearance against motors, axes, bearings, rings, gears, pulleys, belts,
  fasteners, wiring, and vendor envelopes.

Highest-ranked geometry repair targets:

1. `RIGHT_HIP_YAW`: inherited topology plus two interface levels over tolerance.
2. `LEFT_HIP_YAW`: inherited topology.
3. `RIGHT_SHOULDER_PITCH`: inherited open-boundary topology.
4. `RIGHT_TOE`, `LEFT_TOE`: inherited topology.
5. `LEFT_ELBOW`, `RIGHT_ELBOW`: inherited topology.
6. `RIGHT_HIP_PITCH`, `LEFT_HIP_PITCH`, `RIGHT_SHOULDER_ROLL`,
   `LEFT_SHOULDER_ROLL`: topology/coverage blockers.
7. `WAIST_YAW`: spline-fit, topology, and section-coverage blocker.

## Non-Negotiable Constraints

- Preserve the ASIMOV kinematic tree, joint origins, joint axes, actuator count,
  actuator order, and robot height unless a later explicit mechanical change
  updates all dependent profiles and tests.
- Flat metal parts must remain flat. Do not use spatially varying vertex,
  radial, or spine warps on plate-metal structure. Use constant affine transforms
  or reconstruct the part parametrically from planes, holes, bends, and mates.
- Round bores, bearing seats, motor mounts, gear/pulley centers, and ring mates
  must remain circular and coaxial unless a paired replacement component is
  selected.
- Every mate plane listed by `cad/asimov-feminine/param/connections.py` must be
  preserved within tolerance before a shape parameter is exposed.
- STL-only visual meshes may be used as reverse-engineering references, but the
  fembot production source must be STEP/B-rep or a controlled parametric loft
  with recorded fit error, topology, interface, and load proofs.
- Cosmetic shell changes must not overwrite mechanical frame parts. Shells
  should be separate parts with explicit keepouts for motors, fasteners, gears,
  pulleys, rings, wiring, and joint travel.

## Required Proof Gates

Each generated fembot part needs machine-readable proof artifacts for:

- STEP/B-rep source traceability or controlled parametric loft source.
- Material assignment and material properties.
- Manufacturing process fit: CNC/sheet metal, MJF PA12, stainless, aluminum,
  injection molding, or vacuum forming as appropriate.
- Flatness for plate parts.
- Smoothness/curvature continuity for molded or lofted shells.
- Hole, bore, ring, pulley, gear, motor, and fastener constraints.
- Reserved interface preservation.
- Watertight/manifold topology for mesh exports.
- Mesh-vs-source surface distance bounds.
- Collision across known joint ranges.
- MuJoCo compile, forward, and step.
- Whole-robot assembly fit and actuator-count/order preservation.
- Structural sanity: minimum wall thickness, local stress/deflection checks, and
  no impossible undercuts or inaccessible fasteners for the selected process.

The authoritative proof contract list is emitted by:

```bash
python3 scripts/report_asimov_fembot_proof_contracts.py
```

The current ASIMOV collision baseline is emitted by:

```bash
.venv/bin/python scripts/generate_asimov1_collision_sweep_proof.py
```

The current material/manufacturing source classification proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_material_manufacturing_proof.py
```

The current source-STL flatness/smoothness baseline proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_surface_quality_proof.py
```

The current component keepout inventory proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_keepout_proof.py
```

## Optimization Sequence

1. Build a STEP-to-link manifest that maps every ASIMOV simulation link back to
   source fabrication STEP files, material/process folder, and off-the-shelf
   constraints.
2. Split the ASIMOV STEP/B-rep source into the five fembot body groups above,
   while preserving the 28 simulation links as the lower-level authority.
3. Reconstruct the STL-only meshes from attachment interfaces and controlled
   section lofts. Skip logo/text detail; keep smooth moldable surfaces where the
   part is cosmetic.
4. Add constraint catalogs for motors, bearings, rings, gears, pulleys, belts,
   fasteners, wiring envelopes, and joint travel.
5. For each body group, run a bounded envelope minimization:
   keep height and mates fixed, shrink radial/depth/width parameters, reject any
   candidate that fails flatness, smoothness, collision, manufacturing, or
   physics gates.
6. Promote only candidates that pass both per-part gates and whole-robot
   assembly/simulation gates.

## Immediate Next Build Tasks

1. Add a fembot STEP/B-rep inventory script that maps `ASV1_*` fabrication STEP
   files to simulation links and material/process folders.
2. Extend the keepout proof from inventory to clearance checking by fitting
   generated fembot geometry against motor, bearing, ring, gear, pulley, belt,
   fastener, wiring, and joint-travel envelopes.
3. Add generated fembot STEP/loft surface zones so the source-STL surface
   quality baseline can become a process-toleranced flatness/smoothness proof.
4. Repair or reconstruct the highest-ranked failed links, starting with
   `RIGHT_HIP_YAW`, because it blocks hip/upper-leg thinning and already has a
   known interface/topology failure profile.
5. Keep `asimov-feminine` as the exploratory mesh workspace; use this
   `asimov-fembot` workspace for production proof contracts and generated
   artifacts.
