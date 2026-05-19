# Open EDA Flow State of the Art (2025-2026)

This file surveys the open-EDA tool stack as it stood in 2025-2026 and frames
each tool against the live Eliza E1 OpenLane Sky130 flow.

References live in `01_sources/source_inventory.yaml`. AlphaChip-related ML
content is not duplicated here; see `02_analysis/ai_driven_pd.md`.

## 1. Flow controller: OpenLane 2 vs OpenLane 1

OpenLane 2 (`openlane2_repo`, `openlane2_chipfoundry_fork`) is the current
maintained line. It replaces the v1 TCL-driven Python wrapper with a Python
step API, declarative configs (`.json`/`.yaml`), and explicit PDK selection
through Volare.

What this means for Eliza E1:

- `pd/openlane/config.sky130.json` is consistent with the OpenLane 2 config
  shape: top-level `DESIGN_NAME`, `PDK`, `STD_CELL_LIBRARY`, integer
  `FP_CORE_UTIL`, `PL_TARGET_DENSITY`, and direct OpenROAD passthroughs like
  `GRT_*`, `DRT_THREADS`, `RUN_HEURISTIC_DIODE_INSERTION`.
- The E1 setup notes (`docs/three-week-prototype-workstreams.md`) describe a
  Volare PDK fix landed for the OpenLane 2 family, which lines up with the
  required Volare revision.
- The 771.788% utilization incident in the same workstream doc is a classic
  OpenLane 2 symptom when a Sky130 PDK revision is mismatched with the
  OpenLane container - it is not an algorithmic bug. The current run with
  utilization of 0.265 (recorded in
  `research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md`)
  confirms the PDK/container pair now agrees.

Practical 2025-2026 OpenLane 2 deltas worth tracking:

- More granular step API (`openlane.steps`) lets E1 insert custom
  pre/post-route gates (for example, ML congestion predictors) without
  forking the flow.
- Improved Yosys / OpenROAD pinning through `openlane2/dependencies/` reduces
  the surface for "tool version drift" findings flagged by
  `scripts/check_pd_signoff.py`.
- KLayout-based DRC and LVS are now first-class, complementary to Magic and
  Netgen, which is what E1 already runs.

## 2. OpenROAD core (placement / CTS / routing / repair)

OpenROAD 2.0+ (`openroad_repo`, `openroad_docs`) is the active engine.
Components touched by the live E1 flow:

- `gpl` / `dpl` - global and detailed placement.
- `cts` (TritonCTS) - clock tree synthesis; default in E1.
- `grt` (FastRoute-based global router) - exposed in
  `pd/openlane/config.sky130.json` via `GRT_*` knobs.
- `drt` (TritonRoute) - detailed router; `DRT_THREADS=4` in E1.
- `rsz` - design repair / timing repair; E1 runs both `repair_design`
  post-GRT and `repair_timing`.
- `pdn` (`openroad_pdngen_docs`) - power-grid generation.
- `psm` (`openroad_psm_docs`) - static IR-drop / power signoff.

2025-2026 deltas relevant to E1:

1. `repair_design` and `repair_timing` have improved hold-buffering and
   gate-cloning support. The E1 config already enables
   `GRT_RESIZER_GATE_CLONING=true` and `GRT_RESIZER_FIX_HOLD_FIRST=true`,
   which matches the recommended ordering for current OpenROAD releases.
2. `psm` now produces per-instance IR-drop reports that can feed back into
   `pd/signoff/run-manifest.schema.json`. This is the path to satisfy the
   IR-drop evidence requirement in
   `docs/architecture-optimization/physical-power-thermal.md`.
3. Global routing scheduling (`openroad_grtschedule`) supports
   timing-driven routing tweaks; the E1 `GRT_RESIZER_HOLD_SLACK_MARGIN`,
   `GRT_RESIZER_SETUP_SLACK_MARGIN`, `GRT_OVERFLOW_ITERS`, and
   `GRT_ANTENNA_*` knobs are all live in the current config.

## 3. Synthesis: Yosys + ABC

`yosys_repo`, `yosys_docs`, `abc_repo`.

Yosys 0.50+ has improved SystemVerilog support relevant to the CVA6 wrapper
and the NPU RTL under `rtl/npu/e1_npu.sv`. The current E1 OpenLane config
uses `SYNTH_STRATEGY: "DELAY 0"`, `SYNTH_BUFFERING: 1`, `SYNTH_SIZING: 1`,
`MAX_FANOUT_CONSTRAINT: 8`, `MAX_TRANSITION_CONSTRAINT: 0.75`. These are
conservative defaults appropriate for first-silicon Sky130 work.

Relevant 2025-2026 Yosys/ABC notes:

- `abc9` mapping continues to outperform classic `abc` mapping on Sky130
  high-density cells. Worth confirming in an A/B run for E1.
- Improved black-box / SV2017 type handling reduces the number of
  hand-stubbed modules needed for top-level integration. The E1 top
  (`rtl/top/e1_chip_top.sv`) and SoC contract
  (`rtl/interconnect/e1_linux_soc_contract.sv`) should benefit directly.

## 4. Static timing: OpenSTA

`opensta_repo`. OpenSTA is the timing engine inside OpenLane/OpenROAD and is
shared between place/CTS/route and final signoff. Multi-threaded execution
is increasingly stable in 2025-2026 releases; the E1 config sets
`STA_THREADS: 1`, which is the safest setting but trades wallclock time.

For 14A signoff (`docs/spec-db/process-14a-effects.yaml`), OpenSTA is not a
foundry-blessed signoff tool. It is suitable for the Sky130 PD smoke
contract and for AlphaChip evaluation, but not for the final 14A signoff
artifact set. That gap is already declared `fail_closed_process_work_order`
in the spec.

## 5. Physical verification: KLayout + Magic + Netgen

- `klayout_repo` plus `klayout_drc_sky130` for the Sky130 DRC deck.
- `magic_repo` for legacy Sky130 DRC, antenna, and GDS streaming.
- `netgen_repo` for LVS, cross-checked with KLayout LVS where available.

The E1 OpenLane config already enables `QUIT_ON_LVS_ERROR: true` and
`QUIT_ON_MAGIC_DRC: true`, plus `KLAYOUT_DRC_THREADS: 1` and
`KLAYOUT_XOR_THREADS: 1`. Threads are conservative; if container CPU budget
allows it, raising both to match CI worker cores would shorten the loop.

The 2026-05-19 release run reports 0 errors across TritonRoute, Magic, and
KLayout DRC and LVS, which is the right baseline for the next-level
improvements (timing repair, IR-drop signoff).

## 6. Reproducible binary distribution

`oss_cad_suite` packages Yosys, ABC, iverilog, verilator, GHDL, and other
tools as a pinned binary bundle. Useful as a reference for hashing/pinning
in the E1 toolchain manifest. The current E1 setup uses the OpenLane 2
Docker image as the primary pinning mechanism; OSS CAD Suite would be a
second checksum line if/when E1 wants to record digests for every tool
independently (already called out in
`docs/three-week-prototype-workstreams.md` as a pin-and-checksum item).

## 7. What "state of the art" means in 2025-2026 for an open Sky130 flow

In ranked order of practical impact on E1:

1. Run the OpenLane 2 + Sky130 Volare pair end-to-end with a stable PDK pin
   (E1 has reached this state on 2026-05-19).
2. Address `repair_timing` / `repair_design` residuals - the current 23,099
   slew violations and 442 max-cap violations are signs that the post-GRT
   repair budget was not enough; this is an `rsz` tuning problem, not a
   tool-version problem.
3. Add a second flow (OpenROAD-flow-scripts on the same RTL using
   NanGate45 or IHP130) to independently validate the macro placement and
   timing repair results.
4. Add ML predictors (congestion / IR-drop / DRC hotspots) as informational
   passes; do not let them gate the signoff path until they are
   independently calibrated.
5. Pin tool digests (OpenLane Docker, KLayout, Magic, Netgen, OpenROAD,
   Yosys, ABC, Volare snapshot) into a single manifest under
   `pd/signoff/`.

## 8. What is not open-source state of the art

- 14A / 1.4 nm signoff: no open PDK exists. The
  `process-14a-effects.yaml` contract correctly marks this as
  `fail_closed_process_work_order`. Treat any "AlphaChip on 14A" claim as
  planning-only until a foundry PDK is licensed.
- High-resolution OPC, mask synthesis, foundry-grade reliability decks: not
  open source. Sky130 / GF180 / IHP130 cover educational signoff. For real
  14A, foundry sponsorship is required.
