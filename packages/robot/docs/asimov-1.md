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

Current checkpoint: `cad/asimov-feminine/proofs/mujoco-load.json` passes the
strict load gate in the package venv: the profile compiles, forwards, steps
once, resolves all 28 mesh files, and exposes the expected 25 position
actuators.

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
output STLs under `cad/asimov-feminine/`. All 28 now have accepted controlled
section-loft source assignments, but none are yet marked `proven_against_step`
because exact STEP/B-rep body identity is still unresolved. Use the stricter
gate when a change claims complete parametric coverage:

```bash
python3 packages/robot/scripts/inventory_asimov1_parametric_meshes.py \
  --require-fully-parametric
```

That gate must remain failing until every mesh is promoted from bounded
controlled-loft source evidence to fully accepted STEP/B-rep or CAD-kernel
parametric reconstruction evidence with MuJoCo load checks and unchanged
actuator count.

The named source assembly at
`vendor/asimov-1/mechanical/ASV1/ASIMOV_V1.STEP` is now indexed in
`cad/asimov-feminine/proofs/fembot-step-body-index.json` with the isolated
CadQuery/OCP kernel. The current proof is SHA-256-bound to the 287,623,270 byte
main STEP file and records a successful CAD load with 1 value and 1,108
bodies/solids. This proves the top-level STEP source is usable by the CAD
kernel, but it still does not assign exact B-rep bodies to the 28 visual STL
links. `fembot-link-source-assignments.json` now accepts all 28 links through
bounded controlled-loft source proofs while continuing to record the unresolved
exact B-rep candidate for each link.

`cad/asimov-feminine/proofs/fembot-body-matching.json` now reuses that deep STEP
index and ranks 1,124 candidate CAD bodies per visual link: 16 bounded
fabrication bodies plus the 1,108 bodies from `ASIMOV_V1.STEP`. All 28 links
receive a best candidate, and `fembot-link-source-assignments.json` records the
winning source scope and CAD body index. Those STEP matches remain search
candidates only: bbox, MJCF-anchor, and reserved-interface containment ranking
is not exact B-rep identity. The current full-index proof records 22/28 best
STEP candidates rejecting at least one reserved interface envelope, with worst
best-candidate containment residual about 128 mm. The B-rep surface-fit proof
now exports and measures the top three ranked candidates per link: 84 candidate
fits across 12 unique STEP bodies. It still rejects all 28 link fits at the
3 mm surface tolerance; best-per-link sampled symmetric Hausdorff residuals
range from about 30 mm to 141 mm. The proof also records center-aligned and
bbox-affine-aligned diagnostics; even after bbox affine alignment, residuals
remain about 17.7 mm to 84.9 mm and 0/84 candidate fits pass, so the current
ranked STEP bodies fail as shape matches rather than merely pose/scale matches.
`fembot-source-decision.json` now compares those rejected STEP/B-rep candidates
against the accepted controlled-loft source for every link. It records 28/28
decision-ready links, 28/28 selected controlled-loft sources, 28/28 rejected
ranked STEP/B-rep candidates, and 28/28 cases where the controlled loft beats
the bbox-affine-aligned STEP candidate. The accepted per-link source today is
therefore the bounded controlled loft; exact B-rep identity, mate-interface
residuals, and CAD-kernel surface-fit bounds are still missing.

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

Measure whether the generated meshes actually express the cataloged morphology
effects:

```bash
python3 packages/robot/scripts/generate_asimov1_morphology_effects.py
```

Current checkpoint: the generated meshes plus generated fembot MJCF prove all
8/8 cataloged effects
(`global_shell_scale`, `upper_thigh_hip_flare`, `bust_front_gain`,
`back_arch_shift_m`, `calf_back_bulge`, `arm_slim_taper`, and
`torso_waist_cinch_depth`, with `hip_spacing_scale` proven as an assembly
parameter). The generated fembot MJCF points at the parametric STL output,
scales left/right hip-pitch body spacing from 0.135 m to 0.1296 m, and compiles
in MuJoCo. The same generated-MJCF proof records positive compiled body
masses/inertias and a tracked 25-actuator lag response.

The generated fembot collision/dynamics proof now runs its contact sweep against
that substituted MJCF and records contact-pair diagnostics. The generated MJCF
now promotes the physical visual-remediation collider family found by the
contact-tuning sweep: structural-target capsule shortening at length scale 0.5,
ten link-specific residual-fit sub-capsules, and five real contact-enabled
visual-remediation capsules. The current sweep has 82 samples, zero unapproved
samples, zero unapproved contacts, and zero remaining contact pairs. A separate
foot-handling proof now confirms the fembot MJCF preserves the source foot/toe
floor-contact collision geoms, all sampled floor contacts are approved foot/toe
contacts, and the two generated toe links remain flat aluminum plate references
with manufacturing-adjusted 1.5 mm plate previews and zero height delta. The
inertia-calibration proof now also records the CAD-vs-compiled mass/inertia
remediation target: all 28 links are outside the current 10% mass and 25%
diagonal-inertia relative tolerances, with about 31.56 kg of added or remapped
mass required to match the compiled MuJoCo body masses. The controller proof now
also gates the simulated 20 mrad trajectory response profile: median response is
about 0.14 at 20 ms, about 0.96 at 250 ms, and no actuator exceeds the current
4x final-response overshoot cap. The collision/dynamics proof remains
non-accepted because hardware-identified inertia calibration and hardware
motor-controller validation are still open.

The component-constraint proof now separates repeated body-group references
from unique off-the-shelf STEP envelopes before using vendor geometry as a
thinning blocker. It records 105 body-group vendor-envelope references, 67
unique vendor envelopes, 38 duplicate references, and per-assembly coverage for
assemblies 100, 200, 300, 400, 500, 600, and 700. It also groups paths by
content hash, reducing those 67 path identities to 46 unique vendor geometry
hashes and exposing 10 duplicated-geometry hash groups. STEP header parsing now
also finds five unique supplier codes (`1600-0515-0006`, `1602-0032-0006`,
`2806-0005-0004`, `2920-0001-0006`, and `91390A117`) across eight vendor
envelope paths, all shared through the leg/foot assemblies and all still
unclassified. Those eight supplier-code paths now load through the isolated
CadQuery/OCP environment with zero CAD import failures; the largest measured
body extent among the supplier-code targets is 38 mm, while the smaller shared
targets top out at about 13.5 mm. A first orientation-agnostic generated-link
envelope fit check, using a 2 mm margin, passes 34/70 per-code link checks and
fails 36/70, concentrated in ankle-A, hip-roll/yaw, and knee links. The same
fit report now computes the required sorted-envelope growth; the worst current
supplier-code blocker needs about 26.5 mm of additional middle-axis extent on
the affected knee/ankle-A generated envelopes. It also rolls this up by link:
14 leg/foot generated links are checked, and 8 require supplier-code-driven
growth (`LEFT_KNEE`, `RIGHT_KNEE`, `LEFT_ANKLE_A`, `RIGHT_ANKLE_A`,
`LEFT_HIP_YAW`, `RIGHT_HIP_YAW`, `LEFT_HIP_ROLL`, `RIGHT_HIP_ROLL`). The proof
remains non-accepted until those vendor envelopes have classified mounting
semantics and positive generated-geometry clearance alongside bearings/rings,
gears/pulleys, fasteners/threads, and wiring/service access.

The thinness-frontier proof now consumes that supplier-code growth summary as a
separate limiter. It marks the same 8 links as `supplier_vendor_keepout`
limited, carries the 26.5 mm worst required extent growth, and reports the
orientation-agnostic sorted-footprint impact separately from true X/Y area:
supplier-code growth raises the generated sorted-footprint lower bound by about
0.00199 m2. This keeps the lean-envelope accounting honest while still showing
where vendor parts force local thickening.

The generated-CAD proof now also turns that supplier-code growth rollup into
concrete preview geometry. It exports and reloads 8 supplier-vendor-adjusted
CadQuery/OCP STEP envelope candidates under
`cad/asimov-feminine/output/generated-cad/supplier-vendor-adjusted-step/`, one
for each affected ankle-A, hip-roll/yaw, and knee link. All 8 reload as single
solids with zero extent-tolerance failures. The proof replays the original
36 failing supplier-code/link bbox checks against those reloaded previews with
the same 2 mm margin; all 36 now pass, with zero residual required extent
growth. The largest applied axis growth is about 26.5 mm, and the largest
generated-solid volume increase is about 138%. These previews are still
orientation-agnostic envelope growth, not accepted production pockets; they
make the vendor keepout blocker CAD-addressable.

The parametric-constraint manifest now carries the same blocker as explicit
per-link constraints. Eight links receive a `supplier_vendor_keepout_growth`
constraint tied to the component-constraint and thinness-frontier proofs, raising
the manifest to 202 linked constraints and 153 production blockers. The
supplier bbox-growth constraint is now verified for all 8 affected links by the
supplier-vendor-adjusted generated-CAD previews, so the growth requirement is no
longer only a frontier diagnostic. The production blocker remains because exact
placed vendor pockets, mate features, fastener/tool access, and collision/
structural validation are still missing.

A new supplier-pocket planning proof makes that exact-pocket blocker explicit.
It consumes the component-constraint, generated-CAD, and parametric-constraint
artifacts and emits 36 supplier-code/link pocket plans across the same 8
affected links and 5 supplier codes. All 36 plans inherit the verified
supplier-adjusted bbox fit and now carry axis-aligned bbox-center candidate
placement transforms. Those 36 transform hypotheses now also export and reload
as single-solid CadQuery/OCP STEP proxy boxes under
`cad/asimov-feminine/output/generated-cad/supplier-pocket-placement-candidate-step/`,
with zero extent-tolerance failures. None of those placement transforms are
accepted exact STEP assembly/mate placements yet, and all 36 still lack mate
features, fastener/tool-access checks, collision validation, and structural
validation. The proof is therefore `ok` as a planning artifact and non-accepted
as production geometry.

The morphology-parameter readiness matrix now surfaces those parametric
supplier-vendor blockers without changing the existing geometry/source/MuJoCo
usable gate. All 8 morphology controls remain usable in the current controlled-
loft proof sense, and all 8 are supplier-vendor bbox-ready. A stricter exact
vendor-pocket status remains 5/8 ready: `global_shell_scale`,
`upper_thigh_hip_flare`, and `calf_back_bulge` are still blocked until the
affected hip/yaw, knee, hip-roll, and ankle-A envelopes become exact placed
pockets with accepted mate and validation evidence.

The fembot contact-tuning proof sweeps both body-capsule radius scale and
body-capsule centerline length scale in the generated MJCF while preserving
foot/toe floor-contact capsules. The radius sweep tests 1.0 through 0.4: scale
0.8 reduces unapproved contacts from 11 to 4, scale 0.5 reduces them to 2, and
scale 0.4 clears the sampled unapproved contacts. The length sweep also tests
1.0 through 0.4; length scale 0.5 clears sampled contacts while preserving
radius and has better visual-coverage metrics than the 0.4 radius-scale
candidate. The proof also tests structural-targeted length,
reconstruction-target length, link-specific residual-fit, and segmented-axis
multi-capsule sweeps. Targeting only the structurally remediated hip/knee links
clears that contact-risk subset but leaves unrelated contacts. The proof emits
an explicit residual link-specific collider reconstruction plan for five pairs
across eight links: `NECK_PITCH` / `WAIST_YAW`, left and right
elbow-vs-hip-pitch, and left and right elbow-vs-shoulder-roll. A first
link-specific residual-fit candidate applies structural cleanup, then replaces
those residual capsules with ten fitted sub-capsules; the sampled MuJoCo sweep
has zero unapproved contacts and zero remaining contact pairs. A physical
visual-remediation sweep adds five real contact-enabled coverage capsules to
that contact-clean candidate: distal add-back coverage on both knees, a larger
neck-pitch coverage capsule, and a short center distal rail on each knee. That
candidate stays sampled-contact-clean with zero remaining contact pairs and now
passes the visual-fit gate with worst mean outside margin about 32.8 mm and
worst outside fraction 0.8188. A separate non-contact
visual-envelope proxy adds nine local coverage
capsules on those links with `contype=0` and `conaffinity=0`; it keeps the
sampled MuJoCo contact sweep clean and passes visual-fit thresholds with worst
mean outside margin about 31.7 mm and worst outside fraction 0.8188. That proxy
is intentionally not a production collider, but it proves the local coverage
shape the next physical collider family has to preserve without reintroducing
contacts. A second floor-contact proxy assigns the same nine coverage capsules
to contact bit 2 and expands floor `conaffinity` to 3; it remains contact-clean
and visual-fit clean while enabling floor/external contacts, but self-contact is
disabled so it is not production self-collision. Promoting the same nine
coverage capsules to real self-colliders introduces 988 unapproved sampled
contacts across 24 contact pairs. Adding only the same-limb knee-to-ankle-roll
exclusions removes the internal knee-envelope vs foot noise and isolates the
remaining blocker to 12 unapproved contacts across 10 cross-leg knee/hip pairs.
An inward hip-roll cap sweep shows `0.30 rad` still collides, while `0.25 rad`
and `0.20 rad` clear those sampled cross-leg contacts; this is recorded as a
motion/range constraint, not a production geometric collider fix.
The end-of-cycle constrained-joint visual sweep is now recorded under
`packages/robot/evidence/asimov_1_joint_sweep_contact_clean/`. It renders 298
frames and 82 screenshots across all 27 limited hinge joints, starting from the
`0.25 rad` inward hip-roll cap and then tightening five dense-sampled joint
ranges to the contiguous zero-unapproved-contact interval around neutral. The
resulting video/contact-sheet gate reports zero unapproved dense-sweep contacts
and keeps the root height at 0.63 m throughout. Visual review of the contact
sheet shows the robot standing without obvious separated parts; this is still a
cycle evidence gate rather than production acceptance because manual visual
review and hardware-controller validation remain required.
The proof samples generated visual STL vertices against each body collision set;
no tested strategy is production-accepted until the remaining self-collider
envelope, mass/inertia coupling, and controller validation gates
are proven.

The final target is now tracked by an explicit all-CAD/no-STL readiness proof.
`cad/asimov-feminine/proofs/fembot-all-cad-readiness.json` confirms that all 28
links have generated STEP references, with no missing generated STEP links, but
the loadable MuJoCo model still contains 28 STL mesh assets and 28 mesh visual
geoms. The proof is therefore `ok` as a blocker inventory and not accepted as
final geometry. The final acceptance condition is stricter than controlled-loft
traceability: every simulation body must be backed by CAD-parametric STEP/B-rep
or loft geometry and a non-STL MuJoCo representation while preserving mates,
contacts, actuator behavior, and the constrained-joint visual evidence.

Use the strict gate when claiming any parameterized leaner/feminine variant is
ready for generation:

```bash
python3 packages/robot/scripts/validate_asimov1_morphology_parameters.py \
  --require-usable
```

That gate now passes for the controlled-loft source workflow: every affected
link for every cataloged parameter has spline-fit, interface, topology,
surface-distance, accepted source-assignment, and MuJoCo load evidence. Exact
STEP/B-rep readiness remains a separate residual gate, and is still zero until
identity, mate-interface residuals, and CAD-kernel surface-fit bounds are proven.
Use the supplier-vendor bbox gate before claiming a parameterized variant is
clear of measured vendor keepout growth blockers:

```bash
python3 packages/robot/scripts/validate_asimov1_morphology_parameters.py \
  --require-supplier-vendor-ready
```

That gate now passes: 8/8 controls are clear of the measured supplier-code bbox
growth blockers. Use the stricter exact-pocket gate before claiming production
vendor integration:

```bash
python3 packages/robot/scripts/validate_asimov1_morphology_parameters.py \
  --require-supplier-vendor-exact-pocket-ready
```

That stricter exact-pocket gate currently fails: 5/8 controls are exact-pocket
ready and 3/8 remain blocked by missing placed vendor pockets and mate-feature
evidence.

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
current accepted hash-bound reports are `LEFT_SHOULDER_PITCH`,
`RIGHT_SHOULDER_PITCH`, `LEFT_ANKLE_A`, `RIGHT_ANKLE_A`, `LEFT_ELBOW`,
`RIGHT_ELBOW`, `LEFT_HIP_PITCH`, `RIGHT_HIP_PITCH`, `LEFT_HIP_ROLL`,
`RIGHT_HIP_ROLL`, `LEFT_HIP_YAW`, `RIGHT_HIP_YAW`, `LEFT_SHOULDER_YAW`,
`RIGHT_SHOULDER_YAW`, `LEFT_TOE`, `RIGHT_TOE`, `LEFT_WRIST_YAW`,
`RIGHT_WRIST_YAW`, `NECK_PITCH`, `NECK_YAW`, `WAIST_YAW`, and `IMU_ORIGIN`. The ankle, elbow, hip-pitch,
hip-roll, hip-yaw, toe, shoulder-pitch,
shoulder-yaw, waist-yaw, wrist-yaw, and neck reports are preservation-baseline similarity warps that
keep reserved interface slabs inside tolerance; they are still not STEP/B-rep
reconstruction proofs.

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

The strict proof-matrix gate fails if any link listed in
`cad/asimov-feminine/param/connections.py` lacks a current passing proof report.
Spline proof records now include per-ring closure and nondegeneracy evidence:
periodic endpoint closure gap, fitted perimeter, fitted area, and minimum fitted
segment length. `LEFT_ANKLE_A.spline-fit.json` has been regenerated with that
schema and currently records 5/5 fitted rings closed, 5/5 nondegenerate rings,
zero closure gap, positive fitted area/perimeter, preserved interfaces,
watertight topology, and source/output surface distance inside tolerance.

Trace every visual mesh through the parametric replacement chain:

```bash
python3 packages/robot/scripts/generate_asimov_fembot_mesh_traceability.py \
  --require-controlled-loft-ready
```

The current traceability proof is written to
`packages/robot/cad/asimov-feminine/proofs/fembot-mesh-parametric-traceability.json`.
It reports all 28 visual meshes as controlled-loft traceable: source STL hash,
MuJoCo mesh reference, connection spec, part script, output STL hash,
spline-fit proof, attachment-interface proof, topology proof, surface-distance
proof, and accepted source assignment are present for every link. The proof is
still not production-accepted because 0/28 links have exact STEP/B-rep source
identity.

Record the current per-link source decision between controlled loft and ranked
STEP/B-rep candidates:

```bash
python3 packages/robot/scripts/generate_asimov_fembot_source_decision_proof.py \
  --require-decision-ready
```

Rank proof failures by the smallest likely repair if the strict gate regresses:

```bash
python3 packages/robot/scripts/rank_asimov1_spline_fit_failures.py --limit 10
```

At the current checkpoint, spline proof reports are SHA-256-bound to the exact
source and output STL bytes; stale proof JSON no longer counts. The stricter
matrix now also requires ring-integrity fields, so 28/28 visual mesh links pass
the spline/interface/topology/surface-distance/ring-integrity gate. The elbow
links pass through controlled-loft validation with one interface-footprint guard
each, and the shoulder-roll links now use reserved-interface bbox extrema
markers instead of filled footprint collars. Those markers preserve attachment
profiles without adding artificial cap disks through empty source space, so
`LEFT_SHOULDER_ROLL` and `RIGHT_SHOULDER_ROLL` now pass at about 8.2 mm source
distance with closed/nondegenerate rings, preserved interfaces, and watertight
generated lofts. The remaining passing hard links use explicit
`controlled_loft` validation meshes; `LEFT_ANKLE_B` and `RIGHT_ANKLE_B` include
a parametric interface-footprint guard at the toe attachment level, so the toe
slab envelope is preserved without reverting to direct mesh manipulation.

The hip-yaw repair checkpoint promotes both `RIGHT_HIP_YAW` and `LEFT_HIP_YAW`.
A full clean loft fixed topology but missed both reserved interfaces and reached
about 63.5 mm symmetric Hausdorff distance, so the accepted repair uses a
reserved-level similarity warp from the source STL plus a 50 micron in-plane
component separation to split inherited shared-edge contacts. The
`RIGHT_SHOULDER_PITCH` repair caps three tiny inherited boundary loops after a
source-preserving similarity warp. The toe repair uses source-preserving
similarity warps, 500 micron component separation, duplicate-sheet face removal,
and boundary-loop capping to promote both toe links. The toe proofs now report
0 output boundary edges, 0 output nonmanifold edges, heel interfaces inside
tolerance, and under 7.6 mm symmetric Hausdorff distance. The elbow repair uses
source-preserving per-side similarity warps plus 100 micron component separation,
duplicate-sheet face removal, and boundary capping; both elbow links now have
0 output boundary edges, 0 output nonmanifold edges, both reserved interfaces
inside tolerance, and under 13.5 mm symmetric Hausdorff distance. The hip-pitch
repair uses source-preserving similarity warps plus per-side component separation
(`RIGHT_HIP_PITCH` at 500 microns, `LEFT_HIP_PITCH` at 10 microns) and topology
cleanup; both hip-pitch links now have 0 output boundary edges, 0 output
nonmanifold edges, both reserved interfaces inside tolerance, and under 8.9 mm
symmetric Hausdorff distance. The waist-yaw repair keeps the high-detail source
mesh, applies a conservative proof-passing rib/back-arch similarity warp, and
uses mapped component offsets for inherited contact slivers; it now reports
0 output boundary edges, 0 output nonmanifold edges, all three reserved
interfaces inside tolerance, and 2.2 mm symmetric Hausdorff distance.
The IMU-origin repair also keeps the high-detail source mesh, separates
quantized components at 1 micron, removes duplicate nonmanifold faces, and caps
small boundary loops; it now reports 0 output boundary edges, 0 output
nonmanifold edges, all three reserved interfaces inside about 1 micron, and
19.2 mm symmetric Hausdorff distance.

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
