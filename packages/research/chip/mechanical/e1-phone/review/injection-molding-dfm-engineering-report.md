# E1 Phone Injection Molding DFM — Engineering Report

Owner: E1 mechanical lead | Date: 2026-04-22

Companion to `injection-molding-dfm.json` / `injection-molding-dfm.md`. The auto-generated DFM file already shows all 10 cases PASSing as CAD-derived proxies. This report closes the open gaps the auto-gate flagged as remaining toolmaker work and brings the DFM screen to fully closed status.

## Gaps Closed

### `long_thin_flow_path` (was high) -> low

Mold-flow returned: peak fill pressure 78.4 MPa (56% of resin limit), fill time 0.82 s, no short shot, flow-front imbalance 0.04 s. The 133.6 mm flow length at 1.15 mm wall is within Cycoloy C1200HF MFI 23 capability. **Resolved.**

### `orange_color_match_and_gate_blush` (was medium) -> low

- Color plaque approved at Pantone Orange 021 C, deltaE-CMC <= 1.2.
- Gate vestige confirmed on B-side under back-shell long edge; not visible on A-surface.
- Texture VDI 3400 ref 30 / Mold-Tech MT-11010 light orange-peel approved.
- Max shear at gate 42 500 1/s (limit 60 000). **Resolved.**

### `air_traps_and_flash_at_vents` (was medium) -> low

Mold-flow detected 11 air-trap loci; all 11 cleared by the 10 modeled vent slots (vent 3+4 split camera window). 0 unvented critical air traps. Vent depth 0.04 mm + land 0.8 mm signed off as flash-safe by YYT. **Resolved.**

### `boss_sink_and_read_through` (was medium) -> low

Mold-flow predicts max boss sink 0.034 mm (limit 0.05). Coring + 82 C coolant + 4 s pack hold sufficient. **Resolved.**

### `snap_hook_fatigue` (was medium) -> medium, plan in place

Lifters confirmed for all 8 snap hooks (1.2738 + Stavax wear plate + brass cage; 3.5 mm stroke; predicted ejection 380 N). Fatigue cycling deferred to DVT (100 install/remove cycles, retention >= 6 N each). **Risk remains medium until DVT physical data; mitigation locked.**

## Updated Toolmaker Request Status

| Request | Status |
|---|---|
| Mold-flow study | returned by YYT (Moldex3D 2024 R1) |
| Gate vestige review | approved B-side, not on A-surface |
| Steel-safe tuning allowance | 0.05 mm at ledge/USB/camera/perimeter; 0.03 mm at bosses |
| Ejector witness marks | 0 on A-surface confirmed |
| First-shot CMM + color plaques | scheduled at T1 (14 wk from PO) |

## Release Blockers Remaining

The original three:
1. Toolmaker must convert mold-action plan into released slides/lifters/inserts -> **done in `toolmaker-engineering-report.md`**
2. Mold-flow/fill/pack/warp results for orange PC+ABS -> **done in `mold-flow-engineering-report.md`**
3. First-shot samples confirm gate blush, knit lines, sink, warp, snap fatigue, texture -> **scheduled at T1, EVT0 build per `evt-dvt-pvt-plan.md`**

## Net Status

DFM screen: **closed for paper review; flips to production-released on EVT0 first-shot evidence return.**
