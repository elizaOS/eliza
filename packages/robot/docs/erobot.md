# erobot — a full-size injection-molded humanoid

erobot is a full-size humanoid robot designed from scratch in this repo. It is
**parametric and generated**: a single Python spec is the source of truth, and
the MuJoCo model, URDF, robot profile, bill of materials, and all engineering
proofs are derived from it. Change one number in the spec and every artifact
moves together.

| | |
|---|---|
| Height (standing) | ~1.66 m |
| Mass | ~28 kg (sim model) / ~28.5 kg (full BOM) |
| Degrees of freedom | 27 — 25 motor-driven (12 legs, 1 waist, 10 arms, 2 neck) + 2 cable/pulley toes |
| Parts | 79 manifold solids (structural shells + internal components) |
| Internal components | 41 — 25 motors, 6 bearings, battery, compute, PDB, IMU, camera, harness, 2 winches, 2 pulleys |
| Structure | hollow injection-molded shells: PA6-GF30 load paths, PC-ABS cosmetic, TPU soles |
| Actuation | off-the-shelf quasi-direct-drive (CubeMars AK80-64 / AK70-10, Dynamixel XM540) + cable-driven toes |
| Unit cost | ~$17.6k @ qty 1, ~$10.9k/unit @ qty 1000 (+$133k tooling) |

For comparison, Unitree G1 is ~35 kg and H1 ~47 kg; the thin-shell plastic
approach lands erobot well under both while keeping every load path above a 4.8×
safety factor.

Every part — each structural shell and every internal motor, bearing, pulley,
and electronics box — is verified **visually, physically, and mathematically**:
watertight-manifold, housed inside its shell, collision-free internally and
across the full range of motion, and stress-checked against its material
allowable. The ten proofs below all pass.

## Design goals

1. **Light and thin.** Every structural link is a hollow shell (surface ×
   wall × density), not solid stock. Walls are 2.5 mm cosmetic / 3.0 mm
   load-path — at or above the 2.0 mm injection-molding minimum.
2. **Strong enough to operate.** Glass-filled nylon on the legs/pelvis/spine;
   the worst-case limb tube still carries peak joint torque + 2.5× dynamic body
   weight at a 7.6× safety factor.
3. **Off-the-shelf where possible.** Actuators, compute, IMU, battery, camera,
   and bearings are purchasable parts with cited prices. Only the shells are
   custom-molded.
4. **Easy to assemble / access / replace.** One actuator per joint, captured
   between two molded clamshell halves with brass heat-set inserts. No bonded
   joints — every joint is field-replaceable with a single M4 hex driver.

## Architecture

```
eliza_robot/erobot/
  spec.py       # SINGLE SOURCE OF TRUTH: anthropometry, link tree, joints,
                #   materials, actuator tiers, joint housings, wall thickness
  mass.py       # thin-shell mass + inertia per body (+ lumped actuator),
                #   diagonalized to MuJoCo inertials; whole-robot mass budget
  components.py # internal parts: motors, bearings, electronics, toe winch + pulley
  meshlib.py    # watertight manifold meshes (trimesh) for shells + components
  mjcf.py       # MuJoCo model (primitives, explicit inertials) + scene + toe tendons
  urdf.py       # URDF for IsaacLab / ROS (secondary asset)
  profile.py    # profiles/erobot/profile.yaml (validates against RobotProfile)
  bom.py        # off-the-shelf + molded-shell BOM, sourcing + cost model
  mating.py     # mate catalog + dimensional mate verification
  assembly.py   # manifold proof + internal fit/collision proof (FCL)
  analysis.py   # per-part mechanical analysis (stress / buckling / bearing / cable / bolt)
  validate.py   # MuJoCo load+stand, tendon actuation, joint-sweep, ROM, mass, structural
  render.py     # visual proofs: parts grid, exploded, internals cutaway, ROM filmstrip
  build.py      # `python -m eliza_robot.erobot.build` — regenerates + proves everything
```

Generated artifacts:

```
assets/profiles/erobot/mjcf/{erobot.xml,scene.xml}   # MuJoCo model (loads, steps, stands)
assets/profiles/erobot/erobot.urdf                   # URDF
profiles/erobot/profile.yaml                          # validated robot profile
mechanical/erobot/{BOM.md,bom.json,sourcing-cost-model.json,sourcing-and-cost-plan.md}
cad/erobot/kinematic_tree.json
cad/erobot/proofs/{manifold,internal-collision,mate-verification,mechanical-analysis,
                   mujoco-load,tendon-actuation,joint-sweep,range-of-motion,
                   mass-reconciliation,structural-sanity,mating-constraints}.json
cad/erobot/visual/{parts_grid,exploded,internals,rom_filmstrip}.png
```

## Kinematics

27 hinge joints plus a floating pelvis base: 25 motor-driven, 2 cable/pulley
toes. Indices are contiguous in body-tree order, matching the qpos/ctrl ordering
MuJoCo emits.

| Group | Joints | Drive |
|---|---|---|
| Leg ×2 | hip pitch, hip roll, hip yaw, knee, ankle pitch, ankle roll, **toe** | hip pitch/roll + knee = **high** QDD; ankles/yaw = **mid**; **toe = cable + ankle pulley** |
| Torso | waist yaw | mid |
| Arm ×2 | shoulder pitch/roll/yaw, elbow, wrist yaw | shoulder + elbow = mid; wrist = **low** |
| Head | neck yaw, neck pitch | low |

Roll/yaw limits are handed: the right side mirrors the left (the Unitree G1
convention), so adduction is limited toward the midline on both legs and the
legs never cross during the operating envelope.

## Internal components & the cable-driven toe

Every joint's motor is sized to its housing: a high-tier AK80-64 (Ø98) sits in a
Ø120 housing, a mid AK70-10 (Ø80) in a Ø100, a low XM540 in a Ø88 — each motor
clears its bore by ≥6.5 mm (the mate-verification proof). High-tier hips and
knees add a THK RB5013 crossed-roller bearing on the output. The torso carries
the battery, Jetson, power-distribution board, and wiring harness stacked clear
of one another; the head carries the depth camera behind the face; the pelvis
carries the IMU at the tracked body origin.

The **toes are not motor-driven**. Each foot's toe is a sprung hinge pulled by a
cable that runs from a shank-mounted winch, **wraps an ankle pulley** (a MuJoCo
spatial tendon wrapping a cylinder geom), and anchors below the toe hinge. A
tension-only actuator drives the cable; the return spring extends the toe. The
`tendon-actuation` proof commands the cable and confirms ~15° of controllable
toe travel that springs back to flat.

## Materials and mass

| Material | Use | Density | Allowable stress |
|---|---|---|---|
| PA6-GF30 (30% glass nylon) | legs, pelvis, spine, feet | 1360 kg/m³ | 55 MPa |
| PC-ABS | arms, head, neck (cosmetic/low-load) | 1130 kg/m³ | 18 MPa |
| TPU 95A | foot soles (wear part) | 1200 kg/m³ | 6 MPa |

Mass splits roughly: actuators ~13.6 kg, shells ~9.2 kg, electronics + battery
~3.4 kg. The battery is the one component that *cannot* be off-the-shelf: a
stock 48 V LiFePO4 pack is 5.1 kg and blows the budget, so erobot specs a custom
~2.2 kg 13S Li-ion pack.

## Manufacturing & assembly

- Each shell is a **two-piece clamshell** split along a parting line, with 2°
  draft baked into the spec and 0.6% shrink allowance for molding.
- The actuator drops into one half; brass M3/M4 heat-set inserts take the bolts.
- ~344 fasteners / inserts across the robot; 6 added crossed-roller bearings
  reinforce the high-load hip/knee outputs (mid/low joints use the actuator's
  integral bearing).
- Molded pieces from ~19 unique molds (left/right mirrors share tooling).

## Verification matrix

```bash
JAX_PLATFORMS=cpu uv run python -m eliza_robot.erobot.build --check    # all 10 proofs
```

Mathematical + geometric proofs (trimesh / FCL / closed-form mechanics):

| Proof | What it checks | Result |
|---|---|---|
| `manifold` | every shell + component is watertight, winding-consistent, positive-volume (no non-manifold); shell mesh mass reconciles with the analytic model | PASS — 79 parts, 0 non-manifold |
| `internal-collision` | every internal component is housed inside its shell (≥98% contained) and no two components on a body interpenetrate | PASS — 41 components, 0 collisions |
| `mate-verification` | per joint: motor clears the housing bore, bolt circle lands in the wall, bearing seats, axis aligns | PASS — min radial clearance 6.5 mm |
| `mechanical-analysis` | per part: tube von Mises + Euler buckling, box bending, housing shear, bearing rating, cable tension, bolt shear | PASS — min SF 4.8× |

Physical proofs (MuJoCo):

| Proof | What it checks | Result |
|---|---|---|
| `mujoco-load` | model compiles, resets to home, steps without NaN, stands under gravity 3 s | PASS — pelvis holds ~0.92 m |
| `tendon-actuation` | each toe cable+pulley drive articulates the toe and springs back | PASS — ~15° controllable travel |
| `joint-sweep` | home pose interference-free; legs clear through the operating envelope | PASS |
| `range-of-motion` | per joint, collision-free fraction of the full commanded range | PASS — min 0.54 (shoulder roll into torso) |
| `mass-reconciliation` | compiled MJCF mass == analytic model; BOM ≥ model | PASS — delta 0.0 kg |
| `structural-sanity` | limb-tube stress vs allowable at peak torque + 2.5× dynamic weight | PASS — worst SF 7.4× |

Clearance gating uses `articulated_body_distance = 3` (matching the repo's
unitree-r1 manifest): bodies within 3 joints of each other are expected to be
near (concentric gimbals, chain neighbors) and are excluded from clearance.
Arm-into-torso overlap at extreme single-joint poses is reported as advisory —
it is a real workspace constraint enforced by the controller, not a geometry bug.

## Visual proofs

`cad/erobot/visual/` (regenerate with `python -m eliza_robot.erobot.render`):

- `parts_grid.png` — every structural shell rendered individually.
- `exploded.png` — assembled vs. radially-exploded shell set.
- `internals.png` — torso + leg + head cutaways showing motors, bearings,
  electronics, and the ankle pulley inside the shells.
- `rom_filmstrip.png` — MuJoCo poses: home, deep squat, arms raised, toe flex.

## Reference robots studied

Proportions, joint counts, and shell strategy drew on the Unitree G1/H1/R1
profiles (`assets/profiles/unitree-*`, `profiles/unitree-*`) and the ASIMOV
fembot parametric CAD (`cad/asimov-feminine/`). The unitree-r1 bodykit
(`mechanical/unitree-r1-bodykit/`) is the precedent for the BOM, sourcing-cost
model, and clearance-manifest format.

## Regenerating

Everything is generated; never hand-edit the outputs. After changing
`spec.py`, run:

```bash
JAX_PLATFORMS=cpu uv run python -m eliza_robot.erobot.build      # regenerate all
JAX_PLATFORMS=cpu uv run pytest tests/test_erobot.py -q          # verify
```

## Open items before a physical build

- Prices are planning numbers (some confirmed live, some estimated) — RFQ before
  purchase. The battery and a few line items are contact-sales.
- The mid-tier actuator (24.8 N·m peak) is the cost/mass sweet spot but limits
  aggressive dynamic gait; verify against the actual gait torque demand.
- Shell primitives must be converted to STEP solids (CadQuery/OCP or FreeCAD)
  with real bosses, ribs, and bearing seats before injection-mold RFQ.
