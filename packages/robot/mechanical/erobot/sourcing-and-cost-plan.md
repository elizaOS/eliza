# erobot Sourcing and Cost Plan

Date: 2026-05-30

## Design source

- erobot is designed from scratch in this repo. The single source of truth is the
  parametric spec `eliza_robot/erobot/spec.py`; the MJCF, URDF, profile, and this
  BOM are all generated from it.
- Reference robots studied for proportions, joint counts, and shell strategy:
  Unitree G1/H1/R1 (`assets/profiles/unitree-*`) and the ASIMOV fembot CAD
  (`cad/asimov-feminine/`).

## Actuator strategy (off-the-shelf QDD)

| Tier | DoF | Count | Part | Peak torque | Unit mass | Unit $ (qty 1) |
|---|---|---:|---|---:|---:|---:|
| High | hip pitch/roll, knee | 6 | CubeMars AK80-64 | 120 N·m | 0.85 kg | $889.90 |
| Mid | hip yaw, ankles, shoulders, elbows, waist | 15 | CubeMars AK70-10 | 24.8 N·m | 0.52 kg | $398.90 |
| Low | wrist yaw, neck | 6 | Dynamixel XM540-W270 | 10.6 N·m | 0.165 kg | $494.39 |

Quasi-direct-drive units are chosen for backdrivability + integral encoders/bearings,
keeping the joint count of dedicated bearings low. The mid tier at 24.8 N·m peak is
the cost/mass sweet spot but limits aggressive dynamic gait — flagged below.

## Fabrication sources

- **FDM/SLA prototype** (qty 1): local ASA/PETG or service bureau from `assets/profiles/erobot/mesh`
  derived STLs. First fit + aesthetic check, not production-grade.
- **Injection molding** (qty 100-10k): Xometry / Protolabs / Fictiv. Aluminum family
  tools for bridge volume, steel for production. PC-ABS for cosmetic orange shells,
  PA6-GF30 for load paths (legs, pelvis, spine), TPU for soles.
- Resin $/kg used: PA6-GF30 $12.0, PC-ABS $7.0,
  TPU $5.0. Source: Xometry injection-molding cost guide.

## Cost model

- Off-the-shelf: $16,202.74 at qty 1,
  $10,340.00 at qty 1000
  (5 confirmed / 7 estimated prices).
- Custom molded: 19 unique parts / 34 pieces;
  tooling capex $133,000.00.
- **Whole robot: $17,627.13 at qty 1,
  $10,860.39/unit at qty 1000.**

## RFQ package required before quotes

- Production STEP for all 19 unique shells (convert primitives to solids).
- Per-part material + finish callouts; parting-line + draft review (2° draft baked into spec).
- 2D tolerance drawings for actuator-mounting bosses + bearing seats.
- Assembly BOM with fasteners, heat-set inserts, and wiring harness.
- Clearance report (the joint-sweep proof) passing static + dynamic gates.

## Open blockers

- Battery is a custom Li-ion pack (contact-sales); stock LiFePO4 is too heavy.
- RealSense D435i, bearing, fastener, PDB, and TPU prices are estimates pending RFQ.
- Mid-tier actuator at 24.8 N·m peak limits dynamic gait; verify against gait torque demand.
- Shell tooling assumes aluminum family tools; final mold count depends on part splits + draft.
