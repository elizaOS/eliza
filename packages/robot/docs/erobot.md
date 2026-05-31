# erobot — a full-size injection-molded humanoid

erobot is a full-size humanoid robot designed from scratch in this repo. It is
**parametric and generated**: a single Python spec is the source of truth, and
the MuJoCo model, URDF, robot profile, bill of materials, and all engineering
proofs are derived from it. Change one number in the spec and every artifact
moves together.

| | |
|---|---|
| Height (standing) | ~1.66 m |
| Mass | ~26 kg (sim model) / ~27.6 kg (full BOM) |
| Degrees of freedom | 25 (12 legs, 1 waist, 10 arms, 2 neck) |
| Structure | hollow injection-molded shells: PA6-GF30 load paths, PC-ABS cosmetic, TPU soles |
| Actuation | off-the-shelf quasi-direct-drive (CubeMars AK80-64 / AK70-10, Dynamixel XM540) |
| Unit cost | ~$16.2k @ qty 1, ~$10.0k/unit @ qty 1000 (+$91k tooling) |

For comparison, Unitree G1 is ~35 kg and H1 ~47 kg; the thin-shell plastic
approach lands erobot well under both while keeping every load path above a 7×
safety factor.

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
                #   materials, actuator tiers, wall thickness
  mass.py       # thin-shell mass + inertia per body (+ lumped actuator),
                #   diagonalized to MuJoCo inertials; whole-robot mass budget
  mjcf.py       # MuJoCo model (primitives, explicit inertials) + scene + URDF inputs
  urdf.py       # URDF for IsaacLab / ROS (secondary asset)
  profile.py    # profiles/erobot/profile.yaml (validates against RobotProfile)
  bom.py        # off-the-shelf + molded-shell BOM, sourcing + cost model
  mating.py     # actuated-joint + clamshell mate/constraint catalog
  validate.py   # MuJoCo load+stand, joint-sweep clearance, mass + structural proofs
  build.py      # `python -m eliza_robot.erobot.build` — regenerates everything
```

Generated artifacts:

```
assets/profiles/erobot/mjcf/erobot.xml   # MuJoCo model (loads + steps + stands)
assets/profiles/erobot/mjcf/scene.xml    # + ground plane, light, tracking camera
assets/profiles/erobot/erobot.urdf       # URDF
profiles/erobot/profile.yaml             # validated robot profile
mechanical/erobot/BOM.md, bom.json, sourcing-cost-model.json, sourcing-and-cost-plan.md
cad/erobot/kinematic_tree.json
cad/erobot/proofs/{mujoco-load,joint-sweep,mass-reconciliation,structural-sanity,mating-constraints}.json
```

## Kinematics

25 hinge joints plus a floating pelvis base. Indices are contiguous in body-tree
order (legs, waist, arms, neck), matching the qpos/ctrl ordering MuJoCo emits.

| Group | Joints | Actuator tier |
|---|---|---|
| Leg ×2 | hip pitch, hip roll, hip yaw, knee, ankle pitch, ankle roll | hip pitch/roll + knee = **high**; rest = **mid** |
| Torso | waist yaw | mid |
| Arm ×2 | shoulder pitch/roll/yaw, elbow, wrist yaw | shoulder + elbow = mid; wrist = **low** |
| Head | neck yaw, neck pitch | low |

Roll/yaw limits are handed: the right side mirrors the left (the Unitree G1
convention), so adduction is limited toward the midline on both legs and the
legs never cross during the operating envelope.

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
- 320 fasteners / 320 inserts across the robot; 6 added crossed-roller bearings
  reinforce the high-load hip/knee outputs (mid/low joints use the actuator's
  integral bearing).
- 22 molded pieces from 13 unique molds (left/right mirrors share tooling).

## Simulation & proofs

```bash
JAX_PLATFORMS=cpu uv run python -m eliza_robot.erobot.build --check
```

| Proof | What it checks | Result |
|---|---|---|
| `mujoco-load` | erobot.xml + scene.xml compile, reset to home, step without NaN, and stand under gravity for 3 s | PASS — pelvis holds ~0.92 m |
| `joint-sweep` | home pose interference-free, legs clear through 60% operating range; full-range arm/torso overlap reported as advisory (controller-managed) | PASS |
| `mass-reconciliation` | compiled MJCF mass == analytic model; BOM ≥ model (discrete hardware) | PASS — delta 0.0 kg |
| `structural-sanity` | thin-wall bending + axial stress in each limb tube vs material allowable, at peak torque + 2.5× dynamic weight | PASS — worst SF 7.6× |

Clearance gating uses `articulated_body_distance = 3` (matching the repo's
unitree-r1 manifest): bodies within 3 joints of each other are expected to be
near (concentric gimbals, chain neighbors) and are excluded from clearance.

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
