# E1 Phone EVT / DVT / PVT Build Plan

Owner: E1 program lead | Manufacturing partner: Shenzhen Yuyao Tooling Co. (YYT, tooling) + EMS partner (assembly) | Date: 2026-04-28

Three-phase build plan from first-shot samples through production-validation builds. Each phase has a gated exit; no phase advances without explicit reviewer signoff against the criteria below.

## Phase EVT0 — Engineering Validation Test (T1 first-shots)

| Param | Value |
|---|---|
| Phase | EVT0 |
| Build qty | 30 units (5 short-shot + 5 over-pack + 20 nominal at process center) |
| Tooling state | First-shot DOE samples from YYT; tool not yet tuned to GD&T |
| Resin | SABIC Cycoloy C1200HF orange |
| Assembly site | YYT pilot line (no EMS yet) |
| Start | T1 = 14 weeks from PO (tool start) |
| Duration | 2 weeks |
| Cost | $25k materials + $15k engineering = $40k |

**Exit criteria (must all PASS):**
- First-shot CMM on 9 GD&T characteristics within steel-safe envelope (`gdt-fai-results-review.json`)
- Mold-flow predictions correlate within +/- 15% on cycle time, warp, and pressure
- Zero unvented critical air traps observed on first shots
- Cosmetic plaque review: deltaE-CMC <= 1.5 (relaxed at EVT, locked at DVT)
- Functional smoke test on 20 of 20 nominal-process units (display, touch, USB, buttons, audio)
- Snap retention >= 6 N average across 8 hooks on 5 sample tear-down
- No unrecoverable design issue identified (e.g., wall fracture, hook brittleness, gate breakthrough)

**Deliverables out of EVT0:**
- Tool-tuning report (steel-safe removals logged against datums A/B/C)
- Updated `gdt-fai-results-review.json` and `mold-flow-results-template.csv`
- DOE locked center: melt 260 C / mold 82 C / pack 65 MPa / pack 4 s / cool 14 s

## Phase DVT — Design Validation Test

| Param | Value |
|---|---|
| Phase | DVT |
| Build qty | 200 units (full assembly through S1-S8 + 30 pulled for environmental + 20 for drop + 50 for lifecycle) |
| Tooling state | Tool tuned to nominal GD&T; cosmetic plaques approved |
| Assembly site | EMS pilot line, first integration with full S1-S8 stations |
| Start | EVT0 exit + 4 weeks |
| Duration | 6 weeks (build 2 weeks + test 4 weeks) |
| Cost | $100k materials + $60k lab testing + $40k engineering = $200k |

**Exit criteria (must all PASS):**
- Full FAI: 9 CMM dimensions within tolerance per `gdt-release-package.json`
- Environmental:
  - Thermal soak -10 C / +60 C for 48 h: no functional failure, no warp > 0.5 mm
  - IP54: dust per IEC 60529 + splash 10 L/min for 5 min, no ingress
  - Drop: 1.0 m drop per `validation.environmental_targets.drop_height_m`, 26 corners/faces/edges, no functional failure
- Mechanical lifecycle:
  - Side buttons 50 000 cycles each, no force/travel drift > 20%
  - USB-C 20 000 mate cycles per `components.usb_c.cycles`, no continuity failure
  - Snap-hook 100 install/remove cycles, retention stays >= 6 N
- Acoustic / camera / display / RF lab results all populated and PASS (acoustic-results-review, camera-results-review, display-results-review, environmental-results-review JSONs)
- CMF release: deltaE-CMC <= 1.2 on all sampled units; gloss within 12 +/- 3 GU
- Rolled first-pass yield >= 80% on the 200-unit build
- All NCRs from EVT0 closed
- All supplier locks complete (`supplier-evidence-acceptance.json`)

**Deliverables out of DVT:**
- Signed environmental / lifecycle test reports
- Tooling final certificate from YYT (`toolmaker-signoff-package.json`)
- Process control plan first lot evidence (`process-control-results-template.csv`)
- Pilot-line capacity confirmation (>= 100 units/day)

## Phase PVT — Production Validation Test

| Param | Value |
|---|---|
| Phase | PVT |
| Build qty | 1,000 units (500 for OQC/FAI lot, 200 for reliability/HALT, 200 for shipping/retail, 100 for soak burn-in) |
| Tooling state | Production tool, certified mold life cycles started |
| Assembly site | EMS production line, full S1-S8 + SPC active |
| Start | DVT exit + 3 weeks |
| Duration | 4 weeks (build 1 week + test 3 weeks) |
| Cost | $230k materials + $50k testing + $30k engineering = $310k |

**Exit criteria (must all PASS):**
- Rolled first-pass yield >= 92% across 1,000 units
- Process Cpk >= 1.33 on all CTQ dimensions at SPC (per `process-control-engineering-report.md`)
- OQC AQL 0.10 critical: 0 critical defects in n=80 sample
- OQC AQL 0.65 major: <= 1 major in n=80
- OQC AQL 2.5 cosmetic: <= 5 minor in n=80
- HALT/HASS subset (n=20): no critical failure within design envelope (-10 to +60 C, 5-2000 Hz random vibe, 1 m drop)
- 500 h soak burn-in on 100 units: no functional regression, no battery anomalies
- Unit traceability (`unit-traceability-acceptance.json`): every unit has serial, lot, photo, test record
- Retail packaging audit: random pull of 50, all accessories + manuals + label correct

**Deliverables out of PVT:**
- Production-release certificate (PRC)
- Sustained-production CTQ baselines + SPC charts seeded
- Service-and-repair documentation locked
- Warranty rate baseline (target <= 1.5% / 12 mo)

## Phase MP — Mass Production (post-PVT)

- Start: PVT exit + 2 weeks
- Sustained yield target: >= 98%
- Annual volume: 250 000 units (design target)
- Tool life: 750 000 cycles before refresh
- SPC: continuous; tightened inspection on any 2 consecutive lot rejections
- OQC continues at AQL 0.10 / 0.65 / 2.5 normal switching

## Build Summary

| Phase | Qty | Cost | Duration | Cumulative weeks from T0 |
|---|---|---|---|---|
| EVT0 | 30 | $40k | 2 wk | 14 + 2 = 16 |
| DVT | 200 | $200k | 6 wk | 16 + 4 + 6 = 26 |
| PVT | 1,000 | $310k | 4 wk | 26 + 3 + 4 = 33 |
| **Total to PRC** | **1,230 units** | **$550k** | **33 weeks** | |

## Risk Register

| Risk | Phase | Mitigation |
|---|---|---|
| Tool warp during finish machining | EVT0 | YYT certified Class 101; pre-hardened 1.2738 avoids hardening distortion |
| Orange masterbatch streak at gate | EVT0 | Pre-color plaques approved before texture freeze; fan-gate drawn as alternate |
| Snap-hook fatigue under 100-cycle DVT | DVT | EVT tear-down at 20 cycles validates root radius; tune lifter if fatigue trend appears |
| USB-C insertion force drift at 20k cycles | DVT | Stavax shutoff insert resists wear; `evt_fixture_usb_c_insertion_gauge` baselines every 1k cycles |
| Yield gap S4 FPC > 3% scrap | DVT/PVT | Two-operator parallel + AOI on connector seating; redesign FPC routing combs if persistent |
| Color drift lot-to-lot | PVT | Konica spectrophotometer on every IQC lot; masterbatch supplier lock; segregated lot |

## References

- `mold-flow-engineering-report.md` — mold-flow CAE evidence
- `toolmaker-engineering-report.md` — tooling design + NRE + lead time
- `process-control-engineering-report.md` — SPC / AQL plan
- `assembly-line-flow.md` — S1-S8 station detail
- `gdt-release-package.json` — datum scheme + CMM characteristics
- `evt-inspection-plan.json` — EVT measurement plan
- `mechanical-lifecycle-acceptance.json` — button/USB/snap lifecycle gates
- `environmental-validation.json` — thermal/RF/drop/ingress gates
