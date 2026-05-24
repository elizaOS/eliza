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
python3 scripts/generate_asimov1_morphology_effects.py
python3 scripts/validate_asimov1_morphology_parameters.py --require-supplier-vendor-ready
python3 scripts/validate_asimov1_morphology_parameters.py --require-supplier-vendor-exact-pocket-ready
python3 scripts/generate_asimov_fembot_supplier_pocket_plan.py
python3 scripts/generate_asimov_fembot_cad_toolchain_proof.py
python3 scripts/generate_asimov_fembot_source_manifest.py
python3 scripts/generate_asimov_fembot_link_source_assignments.py
python3 scripts/generate_asimov_fembot_mesh_traceability.py
python3 scripts/generate_asimov_fembot_step_body_index.py
python3 scripts/generate_asimov_fembot_body_matching.py
python3 scripts/generate_asimov_fembot_brep_surface_fit.py
python3 scripts/generate_asimov_fembot_source_decision_proof.py
python3 scripts/generate_asimov_fembot_slimming_envelope.py
python3 scripts/generate_asimov_fembot_clearance_projection.py
python3 scripts/generate_asimov_fembot_generated_cad_envelope.py
python3 scripts/generate_asimov_fembot_topology_proof.py
python3 scripts/generate_asimov_fembot_assembly_proof.py
python3 scripts/generate_asimov_fembot_collision_dynamics_proof.py
python3 scripts/generate_asimov_fembot_contact_tuning_proof.py
python3 scripts/generate_asimov_fembot_visual_review_proof.py
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
- 8/8 morphology parameters are usable in the current controlled-loft/source/
  MuJoCo proof sense, and 8/8 are supplier-vendor bbox-ready. The stricter
  exact supplier-pocket CLI gate intentionally fails until placed vendor
  pockets, mate features, and validation evidence are resolved for the blocked
  leg controls.
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
- The proof contract report defines 15 required artifact classes with explicit
  `accepted` fields and minimum evidence fields. A generated fembot body group
  is not promotable until every required proof type has a matching accepted
  artifact.
- Candidate fabrication STEP files are now classified by material/process from
  their source folders (`ALU_7075`, `SML_316L`, `MJF_PA12`, `OFF_THE_SHELF`).
  This proves source classification coverage, but it is not accepted production
  material/manufacturing evidence until generated fembot parts have measured
  wall thickness, flatness/smoothness, tool access, draft/undercut, tolerance,
  mass, and inertia records.
- The material/manufacturing proof now also records generated-part evidence for
  all 28 fembot reference links. Smooth shell references are assigned the
  conservative MJF PA12 baseline and flat foot plates are assigned the 7075
  aluminum baseline; each generated record includes volume-derived mass,
  bbox-inertia input estimates, wall/process checks, draft/tool-access review
  flags, and material/process blockers. The base foot plate design still records
  two wall-thickness failures, while the manufacturing-adjusted foot plate
  preview clears those process-floor failures.
- The fembot source split manifest now anchors the five body groups to the
  ASIMOV STEP source tree. It records 177 unique STEP files and 261 body-group
  STEP references across torso, head, arm, leg, and foot candidates. This is
  not accepted production source proof because all 28 simulation links still
  need exact STEP/B-rep body assignment or controlled-loft reconstruction with
  fit and interface error bounds.
- Per-link source assignment scaffolding now emits 28 candidate link records,
  each with body-group STEP source paths, source STL reference hashes, and the
  required controlled-loft/B-rep matching fields from the production source
  contract. The preferred CAD path is command-line Python/OCC tooling
  (CadQuery/OCP, `build123d`, or a future proven `pycad`) for lofting and STEP
  export; FreeCADCmd is treated only as a fallback because previous FreeCAD
  workflows were brittle.
  Body matching now runs and attaches the best ranked CAD-kernel STEP body to
  every link record. All 28 records remain unaccepted until an exact STEP/B-rep
  identity, mate-interface residual, surface-fit bound, or accepted controlled
  loft is assigned.
- The CAD toolchain readiness proof requires CLI-only STEP import, STEP export,
  section lofts, sweeps, booleans, shell/thicken operations, and face/edge
  selection. PyPI currently exposes `pycad` only as a minimal `0.0.0.1` package,
  so it remains a candidate that needs capability proof rather than the default
  backend. The isolated fembot CAD environment now provisions CadQuery 2.7.0 and
  OCP 7.8.1.1.post1 under `cad/asimov-fembot/cad-env/.venv`, keeping the main
  robot `.venv` small while giving fembot generation a CLI-only OpenCascade
  backend.
- The STEP body index proof now imports a bounded set of fabrication STEP files
  through the isolated CadQuery/OCP env and records B-rep body bounds plus
  volume. The default catalog indexes 16 unique fabrication STEP files across
  the five fembot body groups with zero CAD-kernel load failures. This is still
  not accepted source proof because link-to-body matching, mate-interface
  residuals, and fit error bounds are not solved yet.
- The body-matching proof now ranks candidate STEP bodies against all 28 source
  STL link envelopes using bounded-box center, extent, overlap residuals, and
  MJCF-derived spatial anchors for local origins, joints, child-body mates,
  sites, collision endpoints, and reserved-interface containment residuals. The
  full-index run matches every link to at least one candidate body from the
  indexed STEP catalog, with envelope-only best scores currently ranging from
  about 0.249 to 1.737 and combined scores from about 0.316 to 2.224. The best
  candidate for 18/28 links still misses at least one protected spatial anchor,
  and the best candidate for 22/28 links misses at least one reserved interface
  envelope, with worst best-candidate containment residual about 128 mm. No
  exact B-rep assignment is accepted yet.
- The B-rep surface-fit proof now exports the top three ranked candidates per
  link through the isolated CadQuery/OCP env and measures them against all 28
  source STLs. The current proof evaluates 84 candidate fits across 12 unique
  STEP bodies. All 28 links still reject at the 3 mm tolerance: the best
  best-per-link sampled symmetric Hausdorff residual is about 30 mm and the
  worst is about 141 mm. It now also reports center-aligned and bbox-affine
  aligned diagnostics; bbox-affine aligned residuals still range from about
  17.7 mm to 84.9 mm and 0/84 candidate fits pass, so the current ranked bodies
  are shape mismatches after alignment rather than just pose/scale mismatches.
  This confirms the ranked bodies are only search hints, not exact source
  bodies.
- The source-decision proof now compares the accepted controlled-loft source
  against the rejected ranked STEP/B-rep candidates for every visual link. It
  records 28/28 decision-ready links, 28/28 selected controlled-loft sources,
  28/28 rejected STEP/B-rep candidates, and 28/28 links where the controlled
  loft beats the bbox-affine-aligned STEP candidate. This makes the current
  per-link source choice explicit while keeping production acceptance blocked
  on exact STEP/B-rep identity.
- The morphology-effect proof now checks source-vs-output STL geometry and the
  generated fembot MJCF assembly against the cataloged lean/feminine controls.
  It proves all 8/8 current effects
  (`global_shell_scale`, `upper_thigh_hip_flare`, `bust_front_gain`,
  `back_arch_shift_m`, `calf_back_bulge`, `arm_slim_taper`, and
  `torso_waist_cinch_depth`, plus `hip_spacing_scale` as an assembly parameter).
  Hip spacing is reduced from 0.135 m to 0.1296 m in the generated fembot MJCF,
  which compiles in MuJoCo against the parametric STL output. The generated
  fembot MJCF proof also records positive compiled body masses/inertias and a
  tracked 25-actuator lag response.
- The main fembot inventory now surfaces body-matching status, and the per-link
  source-assignment proof records `body_matching_run: true`,
  `body_matching_matched_links: 28`, and the best candidate STEP path/metrics
  for each simulation link.
- The spline proof matrix now gates ring integrity as well as source STL hash,
  MuJoCo mesh mapping, connection spec, part script, generated STL hash, spline
  fit, attachment-interface preservation, topology, surface distance, and
  accepted source assignment. The stronger spline matrix currently passes 28/28
  links. `LEFT_ELBOW` and `RIGHT_ELBOW` pass through controlled-loft validation
  with one interface-footprint guard each. `LEFT_SHOULDER_ROLL` and
  `RIGHT_SHOULDER_ROLL` now pass with reserved-interface bbox extrema markers
  instead of filled footprint collars, preserving attachment profiles without
  adding artificial cap disks through empty source space. Production acceptance
  still remains false because exact STEP/B-rep source identity is 0/28.
- The slimming envelope proof now computes an initial lower-bound envelope for
  all 28 links from source STL extents plus protected MJCF anchor spans. It
  locks every Z extent to preserve robot height/link length and estimates a
  total X/Y envelope-area reduction of about 77.9%. It also carries process
  constraints from the ASIMOV fabrication classes (`ALU_7075`, `SML_316L`,
  `MJF_PA12`) into each link record: the current global envelope floor is
  stricter than the process wall/feature-size floor, while flatness, smoothness,
  and tool-access checks remain required before generated CAD can be accepted.
- The clearance projection proof now tests those slimmed envelopes against 122
  inventoried local-frame keepout points from joints, actuators, sites, and
  collision capsules. The raw lower-bound projection finds 14 point violations
  across 8 links, with the worst projected clearance at about -18.5 mm in the
  leg group. The clearance-adjusted envelope expands only the needed X/Y axes
  and clears all protected points with about 0.4 mm minimum projected clearance,
  at about 11.7% more X/Y envelope area than the raw slim candidate. This is
  still not a full volume clearance proof for generated CAD.
- The generated CAD proof now writes 28 command-line CadQuery/OCP STEP solids,
  one per link, from those clearance-adjusted envelopes and immediately reloads
  each STEP file to verify single-solid export and bbox dimensions within
  tolerance. The first wall-aware parametric pass uses 1.2 mm hollow smooth
  elliptical loft references for 26 torso/head/arm/leg links and flat plate
  envelopes for the two feet. A conservative sphere/capsule endpoint volume
  check now expands joints, actuators, sites, and collision endpoints by their
  inventoried or default radii before checking the internal cavity; it currently
  reports 73 violations across all 26 hollow links, with the worst projected
  clearance about -52.9 mm. This is expected evidence that the hollow references
  need feature-aware motor/bearing pockets and local envelope expansions before
  they can become accepted manufacturing parts. A height-preserving X/Y-only
  expansion analysis reduces the problem to 27 remaining violations across 20
  links, but 16 links still need Z-axis component clearance if the current
  conservative motor/collision radii are kept. The largest required local Z
  allowance is about 38.4 mm, so those links need pockets, split plates, or more
  precise component envelopes rather than blindly increasing robot height. The
  proof now emits 73 remediation targets: 28 collision keepout targets, 23 motor
  actuator targets, 21 joint-axis targets, and 1 site target. Twenty-seven of
  those remain blocked after X/Y-only expansion, and 23 specifically require a
  Z pocket or component-envelope refinement. It also emits an ordered 26-link
  remediation plan; the first priorities are `WAIST_YAW`, `NECK_PITCH`,
  `LEFT_HIP_YAW`, `RIGHT_HIP_YAW`, `LEFT_KNEE`, `RIGHT_KNEE`,
  `LEFT_SHOULDER_ROLL`, and `RIGHT_SHOULDER_ROLL`. The same proof now exports
  and reloads 73 remediation pocket STEP marker solids under
  `cad/asimov-feminine/output/generated-cad/remediation-pocket-step/`, one for
  each target, so the next boolean pocket/bulge pass has concrete CAD volumes
  to consume. It also exports 26 per-link pocket-set STEP files under
  `cad/asimov-feminine/output/generated-cad/remediation-link-pocket-set-step/`;
  these reload as 33 solids because overlapping target spheres are unioned where
  the CAD kernel can merge them. A first boolean pocketed-preview pass also
  exports and reloads 26 cut-shell STEP files under
  `cad/asimov-feminine/output/generated-cad/pocketed-preview-step/` with zero
  export failures. Seven previews fragment into multiple solids and the worst
  removes about 86.5% of the shell volume, so simple cuts are only diagnostic;
  the production pass needs local bulges, split plates, and component-specific
  pocket design. The structural-risk plan currently flags 11 links; the first
  priorities are `LEFT_WRIST_YAW`, `RIGHT_WRIST_YAW`, `NECK_PITCH`,
  `RIGHT_SHOULDER_ROLL`, `LEFT_SHOULDER_ROLL`, `LEFT_ANKLE_A`,
  `RIGHT_ANKLE_A`, and `LEFT_HIP_YAW`. A local-bulge preview with 3 mm extra
  wall around each pocket exports and reloads 26 more STEP files under
  `cad/asimov-feminine/output/generated-cad/bulged-pocket-preview-step/`; it
  eliminates high-volume-loss links and reduces fragmentation from 7 links to 4,
  so external bulges are a promising next production direction. The residual
  structural-risk plan is now narrowed to `RIGHT_ELBOW`, `LEFT_ELBOW`,
  `LEFT_ANKLE_B`, and `RIGHT_ANKLE_B`; those four still need ribs, split plates,
  local shell thickening, or refined component envelopes. A targeted ribbed
  split-plate preview now runs on those four residual links under
  `cad/asimov-feminine/output/generated-cad/ribbed-bulged-pocket-preview-step/`.
  It exports and reloads four STEP files with zero failures and reduces the
  residual fragmentation/risk count to 0/4. This is still diagnostic geometry,
  not accepted production structure, because the rib layout is a conservative
  bridge cage that still needs material-specific structural simulation, exact
  fastener/bearing interfaces, tool access, and manufacturability proof.
- The generated CAD proof also converts the measured supplier-code growth
  blockers into CAD-addressable preview envelopes. It exports and reloads 8
  supplier-vendor-adjusted STEP candidates under
  `cad/asimov-feminine/output/generated-cad/supplier-vendor-adjusted-step/` for
  the affected ankle-A, hip-roll/yaw, and knee links. All 8 reload as single
  solids with zero extent-tolerance failures. The proof replays the original 36
  failing supplier-code/link bbox checks against those reloaded previews with
  the same 2 mm margin; all 36 pass, with zero residual required extent growth.
  The largest applied axis growth is about 26.5 mm and the largest
  generated-solid volume increase is about 138%. These previews are
  orientation-agnostic envelope-growth candidates; exact placed vendor pockets
  and mate features are still required before acceptance.
- A preliminary structural-sanity proof now consumes the generated CAD/ribbed
  preview evidence and material/process baselines. It records 28/28 generated
  link records, verifies the ribbed preview leaves zero residual structural-risk
  links, and exposes current blockers instead of accepting the design: 26 hollow
  links still have internal cavity blockers, 20 remain blocked after X/Y-only
  volume expansion, and the two foot plate references are below the current
  7075 aluminum process wall floor (0.8 mm generated plate versus 1.5 mm
  process floor). The structural proof now also consumes topology-repair
  preview evidence, so the nine topology-defective generated links are visible
  as topology-safe replacement candidates with preserved envelope and height.
  It now runs 84 analytic preliminary load cases: 3g self-weight cantilever
  bending, 50 N service cantilever bending, and Euler buckling screens for each
  generated link. Six links currently fail at least one analytic screen:
  `LEFT_HIP_YAW`, `LEFT_KNEE`, `LEFT_SHOULDER_YAW`, `RIGHT_HIP_YAW`,
  `RIGHT_KNEE`, and `RIGHT_SHOULDER_YAW`; the worst preliminary safety factor
  is about 0.28 and the worst deflection is about 304 mm. It also computes a
  height-preserving sizing remediation for those six links; the knee links are
  the largest current blockers and need a square minor axis of about 18.6 mm
  under this conservative screen with a 1.05 safety-factor target, up from the
  current 12 mm. The same proof now
  exports six structural-remediation preview STEP files under
  `cad/asimov-feminine/output/generated-cad/structural-remediation-preview-step/`;
  all six reload as single solids while preserving the generated link height
  and center. The remediated preview dimensions are also re-screened, and all
  six pass the same preliminary analytic load checks at the target margin. The
  structural proof now records the thinness tradeoff: the six remediated links
  increase their combined X/Y area by about 74.2%, with the knee previews more
  than doubling their individual X/Y area. It also reruns the generated internal
  cavity keepout proxy on those grown previews. That confirms the structural
  thickening alone does not solve packaging: all six remediated links still have
  residual internal cavity violations, the total remains 20 violations, the
  worst projected clearance remains about -40.3 mm, and the two shoulder-yaw
  links still need Z pockets or refined component envelopes. This proof is
  intentionally non-accepted until exact load cases, fastener edge-distance
  checks, buckling/deflection analysis, and FEA-equivalent verification exist.
- The generated CAD proof now also exports a manufacturing-adjusted plate
  preview for `LEFT_TOE` and `RIGHT_TOE` under
  `cad/asimov-feminine/output/generated-cad/manufacturing-adjusted-plate-step/`.
  This keeps the existing foot X/Y footprint and 1.5 mm STEP bbox height while
  raising the design plate-thickness parameter from 0.8 mm to the 1.5 mm 7075
  process floor, so the structural proof can distinguish a design-parameter
  blocker from an actual robot-height change. The adjusted preview has zero
  process-floor failures, but the base clearance envelope still records the
  original two wall-thickness blockers until the production part definition is
  promoted.
- A generated STEP mesh-topology proof now reloads the 28 generated STEP files,
  exports temporary STL meshes through the CLI-only CadQuery/OCP environment,
  and measures boundary edges, nonmanifold edges, degenerate faces, and shell
  component counts. All 28 STEP sources are single-solid reloads and all 28 mesh
  exports succeed. Nineteen generated mesh exports are currently closed with the
  expected shell component count, while nine still expose topology defects
  (maximum 2 boundary edges, 4 nonmanifold edges, 4 degenerate faces, and 6
  shell components). The same proof now emits a topology-repair preview for
  those nine defective 12 mm-diameter links under
  `cad/asimov-feminine/output/generated-cad/topology-repair-preview-step/`.
  Those previews preserve the requested envelope and height while replacing the
  failing loft tessellation with a sealed hollow cylindrical reference; all 9/9
  repair previews export, reload, mesh-export, and pass the closed two-shell
  topology check. The proof now records promotion deltas too: all 9/9 repair
  previews preserve the envelope and height inside 1e-6 m, with maximum measured
  extent/height error below 4e-13 m and maximum volume delta fraction about
  18.0%. This proof is useful export evidence, but it remains non-accepted
  until the repaired family is promoted into the generated CAD definition and
  rechecked against clearance, structure, interface, surface, and manufacturing
  constraints.
- A whole-robot assembly proof now ties the generated CAD envelope back to the
  ASIMOV MJCF kinematic authority. It records the 28 generated links, 28 visual
  body links, firmware actuator order, body/joint counts, generated/source
  height, mate-gap proxy, and joint-axis proxy. The current reference proof has
  zero missing generated links, zero mate-gap proxy error, and zero axis-delta
  proxy error. It also maps the six structural-remediation preview links back
  onto MJCF bodies: all six are actuated links with child-body interfaces, and
  all six preserve generated center and link height, but all six still need
  exact parent/child mate and collision rechecks after X/Y growth. The two
  shoulder-yaw links are additionally flagged for Z pocket or refined component
  envelope work. The assembly proof remains non-accepted until exact mate
  features, mass/inertia records, fembot-specific collision sweeps, and
  fembot-specific MuJoCo dynamic validation are produced.
- A fembot collision/dynamics scaffold now uses the generated fembot MJCF:
  generated fembot CAD covers all 28 links, the MJCF points at the parametric
  STL output, applies the hip-spacing parameter, and still compiles, forwards,
  and steps in MuJoCo. It also checks that compiled dynamic body masses and
  inertias are positive, records the generated model total mass, and runs a
  20 mrad step response across all 25 actuators to prove the configured lag is
  active. The generated MJCF now promotes the tuned physical collider family:
  structural-target capsule shortening at length scale 0.5, ten link-specific
  residual-fit sub-capsules, and five real contact-enabled visual-remediation
  capsules. The current generated-MJCF sweep has 82 samples, zero unapproved
  samples, zero unapproved contacts, and zero remaining contact pairs. It
  now also consumes a foot-handling proof that preserves the source foot/toe
  floor-contact collision geoms, keeps all sampled floor contacts on approved
  foot/toe geoms, and verifies the two toe links remain flat aluminum plate
  references with manufacturing-adjusted 1.5 mm plate previews and zero height
  delta. The inertia-calibration proof now records the CAD-vs-compiled
  mass/inertia remediation target: all 28 links are outside the current 10%
  mass and 25% diagonal-inertia relative tolerances, with about 31.56 kg of
  added or remapped mass required to match the compiled MuJoCo body masses. The
  controller proof now also gates the simulated 20 mrad trajectory response
  profile: median response is about 0.14 at 20 ms, about 0.96 at 250 ms, and no
  actuator exceeds the current 4x final-response overshoot cap. It remains
  non-accepted because hardware-identified inertia calibration and hardware
  motor-controller validation are still open.
- A fembot contact-tuning proof now runs generated-MJCF body-capsule radius and
  centerline-length scale sweeps while leaving foot/toe floor-contact capsules
  unchanged. The radius sweep tests scales 1.0 through 0.4; scale 0.8 reduces
  unapproved contacts from 11 to 4, scale 0.5 reduces them to 2, and scale 0.4
  clears the sampled unapproved contacts. The length sweep also tests 1.0
  through 0.4; length scale 0.5 clears sampled contacts while preserving radius
  and has better visual-coverage metrics than the 0.4 radius-scale candidate.
  The tuning proof now also tracks the structural-remediation contact subset.
  The baseline has 5 contact pairs involving the strength-remediated hip/knee
  links; the sampled 0.4 radius and 0.5 length candidates clear that structural
  contact-risk subset as well as the general unapproved contact set. They still
  fail visual-fit acceptance, so this is a tuning direction rather than a
  production collider definition. A targeted structural-link length sweep now
  shortens only the remediated-link collision capsules. Targeted scale 0.5
  clears the structural hip/knee contact-risk subset while changing only four
  collision geoms, but it still leaves five unrelated unapproved contacts, so
  global cleanup still needs link-specific collider reconstruction rather than
  a single targeted shrink. The proof now promotes those residual contacts into
  an explicit link-specific collider reconstruction plan: `NECK_PITCH`/
  `WAIST_YAW`, both elbow-vs-hip-pitch pairs, and both elbow-vs-shoulder-roll
  pairs need fitted multi-capsule or convex collider geometry. A reconstruction
  target sweep now shortens only the union of structural-remediation links and
  those residual reconstruction links. Reconstruction-target length scale 0.5
  clears the sampled contacts while touching 12 collision geoms instead of the
  global length sweep's 13, but it still fails visual-fit acceptance. A
  link-specific residual-fit sweep now applies the structural-target cleanup
  and replaces the five residual-pair capsules with ten fitted sub-capsules.
  That candidate clears the sampled MuJoCo contacts with zero remaining contact
  pairs, but it still fails collider-vs-visual acceptance because under-covered
  visual vertices remain. A physical visual-remediation sweep now adds five
  real contact-enabled coverage capsules to the contact-clean candidate:
  distal add-back coverage on both knees, a larger neck-pitch coverage capsule,
  and a short center distal rail on each knee. That candidate remains
  sampled-contact-clean with zero remaining contact pairs and now passes the
  visual-fit gate with worst mean outside margin about 32.8 mm and worst
  outside fraction 0.8188. A separate
  non-contact visual-envelope proxy adds nine local
  coverage capsules across those three links with `contype=0` and
  `conaffinity=0`; it keeps the sampled MuJoCo sweep contact-clean and passes
  visual-fit thresholds with worst mean outside margin about 31.7 mm and worst
  outside fraction 0.8188. This is diagnostic coverage proof, not a production
  collider, because the proxy geoms do not participate in physics contacts. A
  second floor-contact proxy assigns the same nine coverage capsules to contact
  bit 2 and expands floor `conaffinity` to 3; it remains contact-clean and
  visual-fit clean while enabling floor/external contacts, but self-contact is
  disabled so it is not production self-collision. Promoting those same nine
  envelope capsules to real self-colliders introduces 988 unapproved sampled
  contacts across 24 contact pairs. Adding only the same-limb
  knee-to-ankle-roll exclusions removes the internal knee-envelope vs foot noise
  and isolates the remaining blocker to 12 unapproved contacts across 10
  cross-leg knee/hip pairs. An inward hip-roll cap sweep shows `0.30 rad` still
  collides, while `0.25 rad` and `0.20 rad` clear those sampled cross-leg
  contacts; this is a motion/range constraint, not a production geometric
  collider fix. The current end-of-cycle constrained-joint visual sweep records
  a contact-clean candidate under
  `packages/robot/evidence/asimov_1_joint_sweep_contact_clean/`: 298 rendered
  frames, 82 screenshots, all 27 limited hinge joints, a `0.25 rad` inward
  hip-roll cap, and five dense-sampled joint-range tightenings. That sweep has
  zero unapproved dense-sweep contacts and keeps the robot standing, but it
  remains a visual evidence gate rather than production acceptance. A
  segmented-axis multi-capsule sweep now splits each
  body capsule into two or three same-radius segments. The best segmented
  candidate improves visual under-coverage relative to the contact-clean
  full-length shrink, but it still leaves sampled self-contacts, so segmented
  capsules are useful evidence for the next collider family rather than an
  accepted solution.
  The proof still samples generated visual STL vertices against each body
  capsule, and no tested strategy is production-accepted until collider-vs-
  visual fit, mass/inertia coupling, and controller validation
  all pass.
- A visual/mathematical review scaffold now writes generated-CAD SVG review
  views for each body group: front, side, and three-quarter schematic views
  under `cad/asimov-feminine/output/visual-review/`. It also records front and
  side numeric envelopes so the thinness direction is inspectable. This remains
  non-accepted until manual review and final rendered CAD views are completed.
- Source STL surface-quality measurement now runs for 28/28 links and records
  largest planar patch flatness plus adjacent normal-angle discontinuity for
  each mesh. This is useful baseline evidence for deciding which surfaces must
  stay flat versus smooth, but it is not accepted production flatness/
  smoothness evidence until generated fembot STEP/loft surfaces exist with
  material/process tolerances and identified surface zones. The surface proof
  now also inspects the generated CAD reference metadata: 2/28 generated
  surfaces are flat plate references with analytic zero flatness error, and
  26/28 are smooth loft references with continuous CadQuery loft intent. Those
  generated checks have zero current reference failures, but the proof remains
  non-accepted until process-specific manufactured flatness/smoothness zones
  and tolerances are assigned.
- Component keepout inventory now extracts MJCF joint axes, position actuators,
  collision capsules, foot sites, source mesh envelopes, and off-the-shelf
  vendor STEP envelopes. Current counts are 27 joint keepouts, 25 actuator
  keepouts, 33 collision keepouts, 4 site keepouts, 28 source mesh envelopes,
  and 105 body-group vendor-envelope references. The component-constraint proof
  now de-duplicates those into 67 unique off-the-shelf STEP envelopes, reports
  38 duplicate body-group references, and records per-assembly vendor coverage
  (`100`: 5, `200`: 5, `300`: 7, `400`: 7, `500`: 19, `600`: 19, `700`: 5).
  It now also groups those paths by content hash: 46 unique vendor geometry
  hashes, 10 duplicated-geometry hash groups, and 31 path entries in duplicated
  geometry groups. STEP header parsing now surfaces five unique unclassified
  supplier codes across eight vendor envelope paths, all in the leg/foot
  assemblies: `1600-0515-0006`, `1602-0032-0006`, `2806-0005-0004`,
  `2920-0001-0006`, and `91390A117`. The proof now imports all eight
  supplier-code paths through CadQuery/OCP with zero failures and records
  per-path body counts, bbox extents, and volume; the largest measured supplier
  target body extent is 38 mm, and the smaller shared target group tops out at
  about 13.5 mm. A first orientation-agnostic generated-link envelope fit check
  uses a 2 mm margin and currently passes 34/70 per-code link checks while
  failing 36/70, concentrated in ankle-A, hip-roll/yaw, and knee links. It now
  emits the required sorted-envelope growth for each failure; the worst current
  supplier-code blocker needs about 26.5 mm of additional middle-axis extent on
  affected knee/ankle-A generated envelopes. The link-level rollup checks 14
  leg/foot generated links and marks 8 as needing supplier-code-driven growth:
  `LEFT_KNEE`, `RIGHT_KNEE`, `LEFT_ANKLE_A`, `RIGHT_ANKLE_A`, `LEFT_HIP_YAW`,
  `RIGHT_HIP_YAW`, `LEFT_HIP_ROLL`, and `RIGHT_HIP_ROLL`. This is not accepted
  production keepout proof until generated fembot geometry reports positive
  clearance against motors, axes, bearings, rings, gears, pulleys, belts,
  fasteners, wiring, and vendor envelopes.
- The thinness-frontier proof now consumes the supplier-code link-growth rollup
  as its own `supplier_vendor_keepout` limiter. It marks the same 8 links,
  carries the 26.5 mm worst required extent growth, and reports the impact as
  an orientation-agnostic sorted-footprint lower bound: supplier-code growth
  increases that generated lower bound by about 0.00199 m2. This stays separate
  from true X/Y area because the supplier-code fit check is intentionally
  orientation-agnostic until exact vendor placement is known.
- The generated-CAD proof now materializes that same supplier-code growth into
  8 supplier-vendor-adjusted STEP previews under
  `cad/asimov-feminine/output/generated-cad/supplier-vendor-adjusted-step/`.
  Those previews reload cleanly as single solids with zero extent-tolerance
  failures and clear all 36 previously failing supplier-code/link bbox checks
  with the same 2 mm margin, making the vendor blocker a concrete CAD candidate
  rather than only a readiness diagnostic.
- The parametric-constraint manifest now emits `supplier_vendor_keepout_growth`
  constraints for those 8 links, linked to both the component-constraint and
  thinness-frontier proofs. The manifest now carries 202 linked constraints,
  141 verified constraints, and 153 production blockers. The supplier bbox-growth
  constraint is verified for all 8 affected links by the supplier-vendor-adjusted
  generated-CAD previews, while the production blocker remains for exact placed
  pockets, mate features, fastener/tool access, and collision/structural
  validation.
- A supplier-pocket planning proof now consumes the component-constraint,
  generated-CAD, and parametric-constraint artifacts and emits 36
  supplier-code/link pocket plans across the same 8 affected links and 5
  supplier codes. All 36 plans inherit the verified supplier-adjusted bbox fit,
  and all 36 now carry axis-aligned bbox-center candidate placement transforms.
  Those 36 transform hypotheses now also export and reload as single-solid
  CadQuery/OCP STEP proxy boxes with zero extent-tolerance failures. None of
  those transforms are accepted exact STEP assembly/mate placements yet, and all
  36 still lack mate features, fastener/tool-access checks, collision
  validation, and structural validation. The proof is `ok` as a planning
  artifact and non-accepted as production geometry.
- The morphology-parameter readiness matrix now reads that parametric contract.
  All 8 controls remain usable in the current controlled-loft/MuJoCo proof
  sense, and all 8 are supplier-vendor bbox-ready. A stricter exact-pocket
  status remains 5/8 ready: `global_shell_scale`, `upper_thigh_hip_flare`, and
  `calf_back_bulge` are blocked until the affected leg/hip envelopes become
  exact placed vendor pockets with accepted mate and validation evidence.

Highest-ranked geometry repair targets:

The strict spline/interface/topology/surface-distance/ring-integrity ranking is
currently empty: 28/28 visual mesh links pass the stronger proof gate. The next
geometry blockers are outside that ranking: exact STEP/B-rep source identity,
feature-aware pockets/clearances, structural sizing, and production
manufacturing evidence.

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
- The final target is stricter: the accepted model must be all CAD-parametric
  parts, with no simulation STL mesh bodies. Current STL and generated-STL
  outputs are reference/evidence artifacts until every visual and collision body
  is replaced by STEP/B-rep or parametric loft geometry that preserves mates,
  constraints, MuJoCo loading, and constrained-joint visual evidence.
- Controlled-loft spline proofs must also prove every accepted fitted ring is a
  closed, nondegenerate loop. The proof schema records endpoint closure gap,
  fitted perimeter, fitted area, and minimum fitted segment length; the first
  regenerated `LEFT_ANKLE_A` proof records 5/5 closed and nondegenerate rings.
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

The current body-group STEP source split manifest is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_source_manifest.py
```

The command-line CAD readiness proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_cad_toolchain_proof.py
```

The current candidate per-link source assignment proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_link_source_assignments.py
```

The current CAD-kernel fabrication STEP body index proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_step_body_index.py
```

The current bounded source-STL to STEP-body matching proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_body_matching.py
```

The current ranked-candidate B-rep surface-fit proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_brep_surface_fit.py
```

The current controlled-loft-vs-STEP source decision proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_source_decision_proof.py
```

The current initial link slimming envelope proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_slimming_envelope.py
```

The current projected slimming-envelope keepout proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_clearance_projection.py
```

The current generated clearance-adjusted parametric STEP proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_generated_cad_envelope.py
```

The current generated STEP mesh-topology proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_topology_proof.py
```

The current generated-mesh morphology effect proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov1_morphology_effects.py
```

The current generated fembot collider-scale tuning proof is emitted by:

```bash
.venv/bin/python scripts/generate_asimov_fembot_contact_tuning_proof.py
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

1. Run body matching with the isolated CadQuery/OCP env from candidate ASV1
   assemblies to each source STL and mate interface; assign exact STEP/B-rep
   bodies where possible and keep controlled-loft reconstruction only for
   unresolved visual-only links.
2. Replace the generated hollow reference lofts and plate envelopes with
   feature-aware manufacturing parts, then promote protected-point and internal
   cavity checks to volume clearance against motor, bearing, ring, gear, pulley,
   belt, fastener, wiring, vendor, and joint-travel envelopes.
3. Add generated fembot STEP/loft surface zones so the source-STL surface
   quality baseline can become a process-toleranced flatness/smoothness proof.
4. Repair or reconstruct the highest-ranked failed links, starting with
   `RIGHT_HIP_YAW`, because it blocks hip/upper-leg thinning and already has a
   known interface/topology failure profile.
5. Keep `asimov-feminine` as the exploratory mesh workspace; use this
   `asimov-fembot` workspace for production proof contracts and generated
   artifacts.
