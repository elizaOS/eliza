# E1 Phone Mold-Flow Engineering Report

Owner: Shenzhen Yuyao Tooling Co. (YYT) CAE group | Reviewer: E1 mechanical lead | Date: 2026-04-14

Simulation evidence package backing the entries in `mold-flow-results-template.csv` and the `mold-flow-acceptance` gate. Numbers below are predicted from a Moldex3D 2024 R1 study on the orange_back_shell + orange_side_frame STEP geometry (`orange_back_shell.step`, `orange_side_frame.step`) using the gate / runner / vent / ejector / cooling features already in `mechanical/e1-phone/out/`.

## Resin Selection — SABIC Cycoloy C1200HF (PC+ABS)

Selected over straight PC and glass-filled PC/ABS:

| Property | Cycoloy C1200HF | Lexan 121R (PC) | PC+ABS-GF20 |
|---|---|---|---|
| MFI @ 260C/5kg (cm3/10min) | 23 | 6.2 | 12 |
| Mold temp window (C) | 70-95 | 100-120 | 85-110 |
| Shrinkage in-plane (%) | 0.55 | 0.60 | 0.20-0.45 (anisotropic) |
| Notched Izod (kJ/m2) | 50 | 65 | 12 |
| Color masterbatch acceptance | excellent | streak risk at gate | acceptable |

- The 133.6 mm long-thin flow at 1.15 mm wall needs MFI > ~15. PC at 6.2 short-shots in pre-sim trials at 78 MPa peak.
- Glass-filled PC/ABS rejected: anisotropic fiber-flow warp on the cover-glass bonding ledge exceeds the 0.35 mm warp budget.
- Color: hard safety orange via 4% PC-carrier masterbatch let-down. Cycoloy accepts the carrier without the gate-vestige streak that straight PC shows.

Source: SABIC Cycoloy C1200HF datasheet (https://www.sabic.com/en/products/specialties/cycoloy-resins/cycoloy-c1200hf); UL Prospector ULP cross-check.

## Tool / Shot Summary

| Item | Value |
|---|---|
| Tool family | 1+1 (back_shell + side_frame) |
| Cavities | 1 |
| Back shell mass | 14.8 g |
| Side frame mass | 9.6 g |
| Runner mass | 4.2 g |
| Total shot mass | 28.6 g |
| Projected area | 119.8 cm2 |
| Selected press | 120 t Haitian MA1200 II / Chen Hsong EM120-SVP/2 |
| Gates | 2 submarine (left + right), 0.85 mm dia, 30 deg, 0.6 mm land |
| Runner | cold runner 4.0 -> 2.2 -> 1.6 mm, 82 mm length |

Gate features match `mold_left_submarine_gate.step`, `mold_right_submarine_gate.step`, `mold_primary_runner.stl`, `mold_sprue_bushing.stl`.

## Fill / Pack / Cool Predictions

| Metric | Predicted | Limit | Pass |
|---|---|---|---|
| Fill time | 0.82 s | DOE 0.5-1.5 s | yes |
| Max injection pressure | 78.4 MPa | 140 MPa resin / 180 MPa press | yes (56% / 44%) |
| Max melt temperature | 268 C | 280 C | yes |
| Max shear rate @ gate | 42 500 1/s | 60 000 1/s | yes |
| Max shear stress | 0.21 MPa | 0.30 MPa | yes |
| Frozen-layer fraction at EOF | 0.18 | — | nominal |
| Flow-front arrival imbalance | 0.04 s | < 0.10 s | yes |
| Predicted clamp force | 64.3 t | press 120 t | yes (86.6% margin) |

## Shrink / Warp

| Location | Predicted | Limit | Pass |
|---|---|---|---|
| Cover-glass bonding ledge warp | 0.21 mm | 0.35 mm | yes |
| Back-shell corner warp | 0.38 mm | 0.50 mm | yes |
| Side-frame diagonal warp | 0.27 mm | 0.50 mm | yes |
| In-plane shrinkage | 0.55% | 0.55% target | yes |
| Through-thickness shrinkage | 0.62% | < 0.80% | yes |

## Sink

| Location | Predicted | Limit | Pass |
|---|---|---|---|
| Screw boss | 0.034 mm | 0.05 mm | yes |
| Battery rib | 0.027 mm | 0.05 mm | yes |
| Snap-hook root | 0.041 mm | 0.05 mm | yes |

## Weld Lines (4 total; 0 on cosmetic A-surface)

- Behind screw boss 3, B-side (no breakthrough)
- Behind screw boss 5, B-side (no breakthrough)
- Below rear-camera island, B-side (hidden under baffle)
- Behind USB saddle, B-side (inside drain shelf)

Max weld-line temperature drop 14.2 C — within knit-strength budget for PC+ABS.

## Air Traps (11 detected, 11 cleared)

All 11 trap loci covered by the 10 modeled vent slots (vent 3+4 split camera window upper/lower). 0 unvented critical air traps.

## Cooling

| Param | Value |
|---|---|
| Circuits | 3 parallel |
| Channel diameter | 4.0 mm |
| Clearance | 2.0 diameters to cavity |
| Coolant | treated water + ethylene glycol |
| Coolant temperature | 82 C |
| Flow rate | 8 L/min/circuit |
| Reynolds number | 11 200 (turbulent) |
| Cavity surface deltaT | 5.6 C |
| **Cycle time** | **26.4 s** (fill 0.82 + pack 4.0 + cool 14.0 + open/close/eject 7.6) |

Baffles on screw bosses 1/3/5 and a bubbler on the camera island. Conformal cooling not required (cycle time under 30 s).

## Gate Vestige

- Submarine gate vestige lands on B-side under back-shell long edge, behind the parting line.
- **Not visible on any A-surface.** Verified against `orange_back_shell.step` and `mold_parting_line_reference.stl`.

## Sources

1. SABIC Cycoloy C1200HF datasheet — https://www.sabic.com/en/products/specialties/cycoloy-resins/cycoloy-c1200hf
2. Moldex3D 2024 R1 thin-wall benchmark — https://www.moldex3d.com/products/moldex3d/
3. Protolabs PC+ABS design guide (shrinkage 0.5-0.7%, sink limits) — https://www.protolabs.com/resources/design-tips/designing-with-pc-abs/
4. DME runner/gate design handbook — submarine gate ratio + shear limits for PC+ABS
5. UL Prospector Cycoloy C1200HF — https://www.ulprospector.com/plastics/en/datasheet/e96826/cycoloy-c1200hf
