# E1X3D Signoff Accounting

This is the honest, exhaustive signoff ledger for the E1X3D 3D-stacked
wafer-mesh direction. It states, per capability, **exactly what level of signoff
has actually been achieved**, what residual dependency is still blocking the next
level, and the exact command that reproduces (or would prove) each line.

It exists to satisfy the fail-closed law from `AGENTS.md` / the chip-package
`CLAUDE.md`: *claims must be evidence-backed; every blocked milestone fails
closed with a stated missing dependency and a proving command; never claim
silicon / PDK / commercial signoff that is not actually present.* The companion
contract is `docs/arch/e1x3d-wafer-stack.md`; the committed parameter contract is
`research/threed_ic_2026/03_implementation/e1x3d_design_decisions.md`; the ranked
risks are `docs/risks/e1x3d-risks.md`.

## Signoff levels (the only four used in this ledger)

- **architecture-simulation** — a deterministic, reproducible model or RTL
  cocotb proof that runs natively here. It demonstrates an architectural
  quantity or behavior. It is **not** a placed layout, **not** PDK signoff, and
  **not** silicon. This is the dominant level for E1X3D and is correctly scoped
  as such in every model report and gate.
- **open-PDK physical (Sky130 / ASAP7) DRC/LVS/STA** — a single-tier, planar
  physical-design proxy of one E1X3D tile run through the open OpenLane2 flow on
  an open PDK, signed off for that tile in 2D. It is genuine RTL-to-GDS evidence
  for the tile, but it is **not** the 3D stack and carries no inter-tier
  physics.
- **open prototype** — an analytic-feasibility model plus a defined, *runnable*
  open prototype escalation (Open3DBench / OpenROAD-Research Pin-3D/Snap-3D +
  DREAMPlace + HotSpot/3D-ICE). The model is done; the prototype run is the
  declared open next step, not a signoff.
- **BLOCKED-external** — there is **no open path** to this level. It requires a
  commercial 3D EDA license, a foundry / monolithic-3D PDK that is NDA-gated IP,
  or fabricated-and-measured silicon. These lines fail closed with a named tool
  and a proving command and **cannot be "finished" in this repo.**

> The hard truth this ledger encodes: a production foundry 3D PDK (and the
> commercial 3D signoff stack built on it) is NDA-gated intellectual property.
> It cannot be vendored, reproduced, or "completed" here. The BLOCKED-external
> lines below are not locally finishable work — they are work that is structurally
> outside an open-PDK / architecture-simulation repository.

All numeric values in the table are reproduced from the model on
2026-05-28 by running the proving commands; the proving commands re-emit them.

## Capability ledger

| Capability | Evidence artifact / gate | Signoff level achieved | Residual external blocker | Exact proving command |
|---|---|---|---|---|
| **Core scaling: 350,208 logic cores = 2x planar E1X** (512x342 per-tier mesh x 2 logic tiers) | `compiler/runtime/e1x3d_wafer_model.py` (`scaled_e1x3d_config`, `logical_cores`); `eliza.e1x3d.scaled_model_load.v1` (`cores_vs_e1x_planar=2.0`); gate `e1x3d-benchmark` | architecture-simulation | none for the architectural claim. Realized core count depends on the downstream physical/yield levels below. | `.venv/bin/python scripts/check_e1x3d_benchmark.py` |
| **Distributed SRAM: 32 GiB = 4x planar E1X** (96 KiB/core = 48 KiB x (1 + 1 memory tier)) | `e1x3d_wafer_model.py` (`local_sram_kib_per_core`, `local_sram_mib`); `eliza.e1x3d.scaled_model_load.v1` (`local_sram_gib=32.0625`, `sram_vs_e1x_planar=4.0`) | architecture-simulation | none for the sizing claim (4x = 2x cores x 2x per-core SRAM, exact). Physical SRAM-tier realization is gated by the open-PDK / 3D-signoff lines below. | `.venv/bin/python scripts/check_e1x3d_benchmark.py` |
| **XY packing density (footprint shrink from memory-on-logic)** | `compiler/runtime/e1x3d_placement_model.py` (`evaluate_split`); `eliza.e1x3d.placement_feasibility.v1`; gate `e1x3d-placement` | architecture-simulation (analytic placement-feasibility) | none — reconciled (was consistency item 1). The wafer model now uses `xy_footprint_shrink=0.36` (the placement model's block SRAM-on-logic derivation), giving **3.125x** packing density for the default 1-memory-tier config (up to **5.56x** at 2 memory tiers, 0.64 shrink). The unbacked 3.64x headline is removed. | `.venv/bin/python scripts/check_e1x3d_placement.py` |
| **7-port 3D mesh router (UP/DOWN forwarding + disabled-Z-link repair-drop)** | `rtl/e1x/e1x_mesh_router.sv` (PORTS-parametric); `rtl/e1x3d/e1x3d_tile.sv` (PORTS=7); `verify/cocotb/e1x3d/test_e1x3d_mesh_router.py`; `eliza.e1x3d.fabric_cocotb` gate; `build/reports/e1x3d_fabric_cocotb.json` | architecture-simulation (RTL cocotb proof, router only) | RTL of a *full* per-tier RV64 PE; a production 3D router with queues, inter-tier credit flow, and **formal deadlock freedom across Z**; then open-PDK PD and the BLOCKED-external 3D signoff. This proof is router-forwarding only — not a PE, not formal, not wafer-scale, not silicon. | `.venv/bin/python scripts/check_e1x3d_fabric_cocotb.py` |
| **Deterministic 3D defect-map + spare-row/col/plane repair + 3D A* route validation** (normal / high-failure / dead-tier-region) | `e1x3d_wafer_model.py` (`generated_defects`, `repair_map`, `route`, `validate_repaired_mesh`); `eliza.e1x3d.wafer_sort_defect_map.v1` / `repair_manifest.v1` / `repair_rom.v1` sidecars; gate `e1x3d-benchmark` | architecture-simulation | measured wafer-sort defect data (silicon) to replace the seeded defect model; see the silicon line below. | `.venv/bin/python scripts/check_e1x3d_benchmark.py` |
| **Dead-tier-aware Z routing (bounded dead REGION)** — 64-core (8x8) dead block on one tier, 1655 inter-tier Z routes checked | `e1x3d_wafer_model.py` (`DEAD_TIER_SCENARIO_3D`); `eliza.e1x3d.scaled_model_load.v1` (`dead_tier_z_paths_checked=1655`) | architecture-simulation | **owned research gap (honestly bounded), not external:** a *full* dead logical tier at wafer scale requires `spare_tiers>=1`; the scaled config carries `spare_tiers=0`, so full-tier loss **fails closed** in `stack_yield_model`. Closing it needs a spare-plane budget + harvesting policy (RTL/firmware), not a vendor. | `.venv/bin/python scripts/check_e1x3d_benchmark.py` |
| **Stacked-logic thermal ceiling: peak junction 71.4 C at 2 tiers; fails closed > 4 logic tiers, > 1.0 W/mm2 per tier, or > 105 C** | `e1x3d_wafer_model.py` (`thermal_model`); `eliza.e1x3d.thermal_model.v1`; `eliza.e1x3d.scaled_model_load.v1` (`thermal_peak_junction_c=71.4`) | architecture-simulation (ceiling estimate, **not** electrothermal signoff) | **partial-internal + external.** Internal: the +10%/tier factor is the Open3DBench measured +10.04% peak-temp penalty **at 2 tiers only**; for 3-4 tiers it is an unvalidated linear extrapolation, currently bounded by the `thermal_max_logic_tiers=4` hard cap (see "Open consistency item 2"). External: true stacked electrothermal signoff needs a calibrated package model + foundry leakage model (commercial: Ansys RedHawk-SC Electrothermal / Cadence Celsius). | `.venv/bin/python scripts/check_e1x3d_placement.py` (re-emits `thermal_status`) |
| **Stacked electrothermal (planning-grade vertical theta network + leakage fixed point)** | `scripts/generate_e1x3d_stacked_thermal.py` (`eliza.e1x3d.stacked_electrothermal.v1`); gate `scripts/check_e1x3d_stacked_thermal.py` (`build/reports/e1x3d_stacked_thermal.json`) | architecture-simulation (`draft_local_evidence`, `prohibited_until_external_review`) | calibrated package thermal model + foundry leakage model + measured silicon. Commercial: Ansys RedHawk-SC Electrothermal / Cadence Celsius. Always records this BLOCKED dependency. | `.venv/bin/python scripts/check_e1x3d_stacked_thermal.py` |
| **Multiplicative stack-yield gate: 0.9985 stack bond yield (0.9995^3); fails closed when spares can't cover defects or bond yield < target** | `e1x3d_wafer_model.py` (`stack_yield_model`); `eliza.e1x3d.stack_yield_model.v1` (`stack_bond_yield=0.998501`) | architecture-simulation | measured wafer-sort / KGD electrical yield (silicon). The 0.9995 per-**interface** figure is a post-optimization D2W/SoIC-HVM assumption (published whole-interface D2W e-yields are 75-90%), not a measured number for this design. | `.venv/bin/python scripts/check_e1x3d_benchmark.py` |
| **13B W4A8 memory-residency under normal / high-failure / dead-tier-region defects** (`model_loaded`/`model_run_successful=1`) | `compiler/runtime/e1x_wafer_model.py` (`model_load_plan`, `model_execution_plan`); `eliza.e1x3d.scaled_model_load.v1` | architecture-simulation (capacity/sharding feasibility + analytic prefill/decode; **not** a functional inference run or measured throughput) | measured throughput on RTL sim / FPGA / silicon. | `.venv/bin/python scripts/check_e1x3d_benchmark.py` |
| **Inter-tier via budget: block SRAM-on-logic fits production hybrid bond (~6 um) at 24,000 vias/mm2 geometric** | `e1x3d_placement_model.py` (`evaluate_split`, `BONDING_CATALOG`); `eliza.e1x3d.placement_feasibility.v1` | architecture-simulation (analytic via-density vs catalog) | **density honesty caveat (internal):** 24,000/mm2 is the *geometric* budget; TSMC's realizable **F2F SoIC signal density is ~14,000 signals/mm2** at 6 um HVM. The fine-fold path's "1 um hybrid" is research-track vendor guidance (imec W2W 1 um in production for image sensors / 3D NAND only), not 2025 general-logic HVM. The real flow still BLOCKS on the commercial 3D-signoff line. | `.venv/bin/python scripts/check_e1x3d_placement.py` |
| **Tier-split manifest (logic tier 0 vs memory tier 1) + per-tier open-PDK status** | `scripts/generate_e1x3d_tier_split_manifest.py` (`eliza.e1x3d.tier_split_manifest.v1`); gate `scripts/check_e1x3d_3d_split.py` (`build/reports/e1x3d_3d_split.json`) | architecture-simulation (split feasibility); the gate records cross-tier 3D-DRC/LVS as a BLOCKED escalation | cross-tier 3D DRC/LVS over the bonded interface is commercial-only (Siemens Calibre 3D-LVS/3D-DRC, Cadence Integrity 3D-IC); the current logic-tier open-PDK router run is completed but not clean (see next line). | `.venv/bin/python scripts/check_e1x3d_3d_split.py` |
| **Single-tier E1X3D logic-tier PD on Sky130 (planar 2D RTL-to-GDS proxy of one wafer-mesh logic slice)** | `pd/openlane/config.e1x3d-router.sky130.json`; gate `scripts/check_e1x3d_pd_signoff.py` (`build/reports/e1x3d_pd_signoff.json`) | open-PDK physical (Sky130) DRC/LVS/STA — **target level; currently BLOCKED by clean-signoff violations** | a completed OpenLane2 `e1x3d_router7` run exists with GDS/DEF/netlist and clean DRC/LVS/hold/setup counts, but the gate fails closed on antenna and max-slew violations (`build/reports/e1x3d_pd_signoff.json`: 71 antenna nets, 72 antenna pins, 71 route antenna violations, 222 max-slew violations). This is a planar logic-tier proxy — it is **not** the 3D stack. | `OPENLANE_CONFIG=pd/openlane/config.e1x3d-router.sky130.json scripts/run_openlane.sh --config pd/openlane/config.e1x3d-router.sky130.json && .venv/bin/python scripts/check_e1x3d_pd_signoff.py` |
| **Single-tier E1X3D tile PD on ASAP7 (predictive 7nm finfet-shape-only proxy)** | `pd/openlane/config.e1x3d-tile.asap7.json`; `pd/constraints/e1x3d_tile.asap7.sdc` | open-PDK physical (ASAP7) — predictive, finfet-shape-only; **not signoff** | ASAP7 is a predictive academic PDK (no manufacturable signoff); numbers route only through `scripts/project_ppa_to_n2p.py`. | `OPENLANE_CONFIG=pd/openlane/config.e1x3d-tile.asap7.json scripts/run_openlane.sh --config pd/openlane/config.e1x3d-tile.asap7.json` |
| **Real 3D placement + thermal co-analysis (full-PE folded layout)** | `e1x3d_placement_model.py` (`open_prototype_path`); `research/threed_ic_2026/02_analysis/3d_placement_benchmarks_yield_thermal.md` | open prototype (model done; prototype run is the declared open escalation) | running the configured tier split through Open3DBench (Nangate45_3D, DREAMPlace) + OpenROAD-Research (Pin-3D / Snap-3D) + HotSpot / 3D-ICE. Open and runnable, not yet wired as a gate here. | `.venv/bin/python scripts/check_e1x3d_placement.py` (emits `open_prototype_path`); prototype run is external to this gate |
| **3D DRC / LVS, electrothermal, SI/PI signoff (the actual 3D stack)** | `eliza.e1x3d.placement_feasibility.v1` (`blocked_signoff_path`); `e1x3d-signoff` (documented BLOCKED); `docs/risks/e1x3d-risks.md` | **BLOCKED-external** | **No open path.** Requires Cadence Integrity 3D-IC + Celsius / Sigrity, **or** Synopsys 3DIC Compiler + 3DSO.ai + RedHawk-SC Electrothermal, **or** Siemens Calibre 3D-LVS/DRC — all licensed commercial tools. **Cannot be finished in-repo.** | open prototype first (`.venv/bin/python scripts/check_e1x3d_placement.py`), then a licensed commercial 3D signoff flow (no installed open tool can produce 3D DRC/LVS/electrothermal/SI-PI signoff) |
| **Fine per-PE logic fold on monolithic-3D (sequential-integration / MIV ~70-100 nm pitch)** | `e1x3d_placement_model.py` (`fine_logic_fold`, `monolithic_miv` in `BONDING_CATALOG`); `eliza.e1x3d.placement_feasibility.v1` | **BLOCKED-external** | A foundry / research **monolithic-3D sequential-integration PDK** (NDA-gated). The open model can only assert via-density feasibility (~100,000 MIV/mm2), **not** a real M3D process (ultra-low-thermal-budget <500 C FETs). | obtain an M3D PDK and run `fine_logic_fold` through it (the open `evaluate_split` asserts via density only) |
| **Measured silicon / FPGA / board benchmark vs E1X** (wafer sort, package, warpage, thermal-cycling / EM reliability) | `docs/arch/e1x3d-wafer-stack.md` (claim boundary); `docs/risks/e1x3d-risks.md` (reliability row) | **BLOCKED-external** | Fabricate (D2W + KGD/KGS + IEEE 1838) and measure on hardware. No installed tool produces measured stacked silicon; CTE/warpage/EM reliability requires physical thermal-cycling test. | fabricate and measure on hardware (no open tool produces measured stacked silicon) |

## What is genuinely signed off, plainly stated

- **Open-PDK physical signoff actually achieved today:** none of E1X3D is yet at
  a *passing* open-PDK level. The single-tier Sky130 logic-tier PD is the **only**
  open-PDK signoff *target* in scope, and its gate currently reports **BLOCKED**
  because the completed `e1x3d_router7` run has nonzero antenna and max-slew
  violations. When that run lands clean, it signs off **one planar logic-tier
  slice in 2D on Sky130** — not the 3D stack. The ASAP7 variant is predictive
  finfet-shape-only and never signoff.
- **Architecture-simulation, genuinely reproducible today:** core/SRAM scaling,
  3D defect repair + Z routing, the bounded dead-tier-region scenario, the
  thermal-ceiling and stack-yield *gates* (as fail-closed estimates, not
  measurements), the placement-feasibility split, the planning-grade stacked
  electrothermal network, and the 7-port 3D router RTL cocotb proof. Every one
  of these states its claim boundary in its own report.
- **Irreducibly external (cannot be finished here):** 3D DRC/LVS +
  electrothermal + SI/PI signoff (commercial 3D EDA), a monolithic-3D /
  sequential-integration PDK for any fine per-PE fold (NDA-gated foundry IP), and
  measured stacked silicon with package/warpage/EM reliability data. These are
  fail-closed with named tools and proving commands and are out of scope for an
  open-PDK / architecture-simulation repository **by construction.**

## Overclaim corrections applied (adversarial audit)

The one material overclaim found in audit is corrected in this ledger and must
not be restated elsewhere:

- **"3.64x planar packing density" was not backed by any feasible split — now
  fixed.** The headline rested on a hardcoded `xy_footprint_shrink=0.45` in
  `E1X3DConfig` that the placement model never produces. It is now set to
  **0.36** (the placement model's block SRAM-on-logic derivation), so the wafer
  model reports **3.125x** (1 memory tier) and **5.56x** (2 memory tiers, 0.64
  shrink); **no doc states 3.64x.** The underlying ~36-64% footprint-shrink range
  is itself sound and Open3DBench-grounded (two-tier -51.19% area, single-design);
  only the interpolated 3.64x midpoint was unbacked, and it is gone.

Density-honesty caveats carried forward (consistent with the source artifacts,
not overclaims): the 24,000 vias/mm2 block-split figure is the *geometric* via
budget — realizable F2F SoIC **signal** density is ~14,000 signals/mm2 at 6 um
HVM (TSMC); and the fine-fold "1 um hybrid" path is research-track vendor guidance (imec W2W
1 um is in production for image sensors / 3D NAND, not general-logic HVM), which
is exactly why fine folding BLOCKS on the M3D-PDK line above.

## Consistency items from audit — both RESOLVED (internal, not external blockers)

The two non-external items the adversarial audit raised were model/doc
consistency fixes runnable with the native toolchain. Both are now closed:

1. **Packing-density constant reconciled with the placement model — DONE.**
   `E1X3DConfig.xy_footprint_shrink` was changed from the unbacked hardcoded 0.45
   to **0.36**, which is exactly the placement model's block SRAM-on-logic
   derivation (logic 0.018 mm2 over SRAM 0.032 mm2 -> footprint 0.032 mm2 ->
   1 - 0.032/0.050 = 0.36). The wafer model now reports **3.125x** packing
   density (2 logic tiers / 0.64), matching the placement model, and the 3.64x
   headline is removed from every doc.
   Verify: `.venv/bin/python -m pytest scripts/test_e1x3d_wafer_model.py scripts/test_e1x3d_placement_model.py -q`
2. **Thermal >2-tier extrapolation annotated — DONE.** `thermal_model` now emits
   `per_extra_tier_factor_basis =
   "open3dbench_measured_at_2_tiers_linear_extrapolation_beyond_pending_hotspot_3dice"`
   and a `claim_boundary` field, stating the +10%/tier factor is measured only at
   two tiers and is a linear extrapolation at 3-4 tiers (bounded by
   `thermal_max_logic_tiers=4`) until a HotSpot / 3D-ICE co-analysis substantiates
   it. It is explicitly not a thermal-signoff claim.
   Verify: `.venv/bin/python scripts/check_e1x3d_stacked_thermal.py`

## Hardened research anchors (for the numbers in this ledger)

- **Conduction/air per-tier power-density ceiling = 1.0 W/mm2 (~100 W/cm2).**
  Air/conduction cooling is inadequate above ~50-100 W/cm2; microchannel liquid
  cooling clears 1000+ W/cm2. Validates `tier_power_density_ceiling_w_per_mm2 =
  1.0` (the default 0.6 W/mm2 sits safely under it). A microchannel-cooled
  variant could raise the ceiling toward 10 W/mm2.
- **Per-folding peak-temp penalty = +10.04% at 2 tiers** (Open3DBench, arXiv
  2503.12946v1, OpenROAD-based 8-design study). Directly validates
  `per_extra_logic_tier_temp_factor = 0.10` **at the two-tier point**; >2 tiers
  is extrapolation (consistency item 2).
- **Dual-sided / backside-cooling rise reduction.** ITherm-2024 reports 72.2%
  temperature-*rise* reduction at 100 W for BSPDN stacks; an alternate basis
  reports 22% logic max-temp reduction. The default `dual_side_rise_reduction =
  0.40` is conservative within the credible 0.22-0.72 band.
- **Active-logic-tier thermal cap = ~2-4 tiers without inter-layer liquid
  cooling.** Validates `thermal_max_logic_tiers = 4`; the default `logical_tiers
  = 2` is well within it.
- **Hybrid-bond pitch = 6 um SoIC HVM (2025-2026).** Validates
  `inter_tier_via_pitch_um = 6.0` as current high-volume manufacturing; vendor target
  4.5 um (2029); imec W2W 1 um in production for image sensors / 3D NAND only.
- **F2F SoIC signal density = ~14,000 signals/mm2** (TSMC; vs ~1,500 signals/mm2
  for F2B TSV). This — not the 28,000/mm2 geometric figure — is the realizable
  signal-budget cap; the 24,000 vias/mm2 block split is the geometric budget.
- **Monolithic-3D MIV = ~50-100 nm pitch, up to ~100,000 MIV/mm2,
  sequential-integration <500 C.** Underpins the `monolithic_miv` catalog entry;
  remains BLOCKED-external on an M3D PDK.
- **Per-interface bond yield = 0.9995 (post-optimization D2W/SoIC HVM).**
  Published whole-interface D2W electrical yields are 75-90%; 0.9995 is a
  per-bonded-interface optimized-HVM assumption, not a measured number for this
  design. `0.9995^3 = 0.9985` for the 3-interface E1X3D stack, above the 0.95
  target. **D2W + KGD is required** because W2W forfeits known-good-die selection
  (W2W total yield = product of both wafers' yields, no sparing recovery).
- **Open3DBench two-tier folded PPA (single-design bests):** footprint -51.19%,
  wirelength -24.06%, power **-5.72% (modest — do not claim large power wins from
  folding alone)**, timing TNS +30.84%. These ground the footprint-shrink range
  and the `TWO_TIER_WIRELENGTH_DELTA = -0.24`.

## Re-run the whole ledger

```sh
.venv/bin/python scripts/check_e1x3d_benchmark.py        # core/SRAM scaling, repair, thermal+yield gates
.venv/bin/python scripts/check_e1x3d_placement.py        # packing-shrink, via budget, thermal_status, open prototype path
.venv/bin/python scripts/check_e1x3d_fabric_cocotb.py    # 7-port 3D router RTL cocotb proof
.venv/bin/python scripts/check_e1x3d_3d_split.py         # tier-split feasibility + 3D-DRC/LVS BLOCKED escalation
.venv/bin/python scripts/check_e1x3d_stacked_thermal.py  # planning-grade stacked electrothermal gate
.venv/bin/python scripts/check_e1x3d_pd_signoff.py       # single-tier Sky130 logic-tier PD (BLOCKED until clean antenna/slew)
.venv/bin/python -m pytest scripts/test_e1x3d_wafer_model.py scripts/test_e1x3d_placement_model.py -q
```

The architecture-simulation and open-prototype gates above pass (or fail closed
exactly as designed). The open-PDK Sky130 logic-tier PD is BLOCKED until the
completed router run closes antenna and slew. The 3D-stack signoff, the M3D PDK, and measured silicon are
**BLOCKED-external** and stay that way until non-open resources exist — which is
the correct, honest end state for this repository.
