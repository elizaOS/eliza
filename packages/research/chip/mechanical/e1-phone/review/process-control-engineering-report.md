# E1 Phone Process Control Plan — Engineering Report

Owner: E1 manufacturing engineering | Build pilot: Shenzhen Yuyao Tooling Co. (YYT) + EMS partner | Date: 2026-04-28

Backing document for `process-control-results-template.csv` and the `process-control-plan` gate. Captures SPC, CTQ characteristics, AQL plan, IQC/IPQC/OQC sampling, color deltaE and gloss limits.

## SPC Plan (per station)

| Station | CTQ | Subgroup size n | Frequency | Chart | Cp/Cpk target |
|---|---|---|---|---|---|
| Incoming quality | 9 supplier critical dims | 5 | per lot | Xbar-R | Cpk >= 1.33 |
| Display bond | cover glass xy, adhesive comp, FPC bend R, luminance | 5 | every 2 h | Xbar-R | Cpk >= 1.33 |
| PCB flex integration | flex continuity ohm, battery clearance mm | 5 | every 2 h | Xbar-R | Cpk >= 1.33 |
| Optical/audio stack | camera offset mm, audio loopback dBFS, leak dB | 5 | every 2 h | Xbar-R | Cpk >= 1.33 |
| Side/bottom IO | USB insertion N, button force N, travel mm | 5 | every 2 h | Xbar-R | Cpk >= 1.33 |
| Final mechanical close | gap/flush mm, screw torque N-cm, snap retention N | 5 | every 1 h | Xbar-R | Cpk >= 1.50 |
| Final acceptance | function pass rate, CMF deltaE, serial trace | n=20 | continuous | p-chart | yield >= 95% |

Each chart has UCL / LCL at +/- 3 sigma. Western Electric run rules apply; 2-of-3 outside +/- 2 sigma triggers operator escalation; any point outside +/- 3 sigma stops the station.

## Critical-to-Quality (CTQ) Dimensions

Drawn from `gdt-release-package.json` and `tolerance-stack.json`. Monitored per FAI on every shift change and per the 5-sample SPC subgroup.

| CTQ | Spec | Tolerance | Gauge |
|---|---|---|---|
| Cover-glass bonding ledge flatness | 0.000 datum C | 0.05 mm | Zeiss Contura G2 CMM |
| Cover-glass ledge xy position | nominal | +/- 0.10 mm | CMM |
| USB-C aperture centerline (datum B) | nominal | +/- 0.08 mm | CMM + optical comparator |
| Camera window land flatness | datum | 0.04 mm | optical flat |
| Side-frame to back-shell mating step | 0.000 | 0.10 mm | feeler 0.05-0.50 mm Mitutoyo 184-303S |
| Snap-hook retention force | >= 6 N each | n/a (one-sided) | pull-test rig calibrated annually |
| Screw boss minor diameter | 1.80 mm | +0.05 / -0.00 | pin gauge |
| Mass total | 185 g target | +/- 3 g | calibrated balance Ohaus EX223N |
| Gap/flush around perimeter | 0.000 | 0.15 mm | feeler |
| Orange color (deltaE-CMC vs Pantone 021 C) | 0.0 | <= 1.2 | Konica CM-700d spectrophotometer |
| Gloss 60 deg | 12 GU | +/- 3 GU | BYK micro-gloss 60 |
| Pencil hardness scratch | 2H | one-sided | ASTM D3363 kit |
| Drop / functional | function-pass | one-sided | drop fixture + function rack |

## AQL Plan (per ISO 2859-1, ANSI/ASQ Z1.4 equivalent)

Single-sample plans, general inspection level II, switching rules normal/tightened/reduced per ISO 2859-1.

| Stage | AQL | Sample plan (lot 1k) | Accept / Reject |
|---|---|---|---|
| IQC supplier incoming (critical) | 0.10 | n=80 | 0 / 1 |
| IQC supplier incoming (major) | 0.65 | n=80 | 1 / 2 |
| IQC supplier incoming (minor) | 2.5 | n=80 | 5 / 6 |
| IPQC in-process critical | 0.40 | n=80 | 1 / 2 |
| IPQC in-process major | 1.0 | n=80 | 2 / 3 |
| OQC finished (critical) | 0.10 | n=80 | 0 / 1 |
| OQC finished (major) | 0.65 | n=80 | 1 / 2 |
| OQC finished (minor cosmetic) | 2.5 | n=80 | 5 / 6 |

Lot 1 (first lot from EVT/DVT tooling): 100% inspection. AQL switching to normal at lot 2 once Cpk >= 1.33 on all CTQs.

Tightened inspection trigger: any rejection at OQC, any field warranty return for that defect family, any SPC out-of-control signal that escapes containment.

## IQC (Incoming Quality Control)

Per supplier, per lot:
- Documents: drawing rev + STEP rev + Certificate of Conformance + RoHS/REACH where applicable
- Identity: sample bagged + lot number scanned into MES
- Dimensional: 9 critical dims per `gdt-release-package.json` at AQL 0.10/0.65/2.5
- Mechanical: snap retention spot check (3 of 80), boss strip torque (3 of 80)
- Cosmetic: lightbox D65 ISO 3664 P2, deltaE-CMC vs reference plaque, n=8 per lot

## IPQC (In-Process Quality Control)

- Station-level SPC charts on CTQs above
- First-piece inspection at every shift start (operator + IPQC engineer + reviewer)
- Patrol inspection every 2 h: 5-piece subgroup pulled from line WIP, results entered into MES
- Tool maintenance: ejector pin inspection every 5 000 cycles; lifter cage every 25 000 cycles; cavity polish refresh every 100 000 cycles

## OQC (Outgoing Quality Control)

- Functional: full smoke test (display, touch, cameras, audio, USB, buttons, radio) at AQL 0.10 critical
- Cosmetic: D65 lightbox visual audit at AQL 0.65 major, 2.5 minor
- Color/gloss: spectrophotometer + gloss meter n=8 per lot
- Final photo: each unit photographed on CMF lightbox; image archived with serial in MES
- Pack-out audit: random pull at AQL 0.65, verify accessories, labels, manuals

## Color and Gloss Limits

| Param | Reference | Tolerance |
|---|---|---|
| Color | Pantone Orange 021 C (Lab*: L=66, a=51, b=68) | deltaE-CMC <= 1.2 vs molded production plaque |
| Gloss 60 deg | 12 GU | +/- 3 GU |
| Gloss 85 deg | 8 GU | +/- 3 GU |
| Texture | VDI 3400 ref 30 / Mold-Tech MT-11010 | Ra 1.6-2.5 um |
| Surface defects | none | max 1 minor < 0.3 mm per 100 cm2 |

Measurement protocol: Konica CM-700d spectrophotometer (8 mm aperture, SCI mode, D65/10 deg observer), BYK micro-gloss 60 (calibrated against NIST-traceable standards). 5-point measurement per part (4 corners + center) averaged.

## Sources

1. ISO 2859-1:1999 Sampling procedures for inspection by attributes
2. ANSI/ASQ Z1.4-2003 (R2018) — sampling plan switching rules
3. AIAG SPC Reference Manual 2nd ed. — Xbar-R, Western Electric run rules
4. ASTM D3363 — Standard test method for film hardness by pencil test
5. ISO 3664:2009 — Graphic technology and photography — viewing conditions
6. ASTM D2244 — Standard practice for calculation of color tolerances and color differences (deltaE-CMC)
