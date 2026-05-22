# E1 macro-array placement replay — post-route PPA (2026-05-21)

First **real** E1 multi-movable-macro placement experiment with deterministic
OpenLane replay. This closes the long-standing gap that blocked macro-placement
candidate replay: the previous E1 floorplan had a single *fixed* SRAM macro and
no movable-macro decision to optimise, so every candidate was quarantined
`blocked`. This experiment introduces a design with eight movable hard macros
and shows that placement measurably changes post-route PPA.

## Design under test

- **RTL:** `rtl/npu/e1_npu_weight_buffer_array.sv` — an NPU weight-buffer bank
  array instantiating **8** `e1_weight_buffer_sram` banks, each wrapping the
  PDK-prebuilt Sky130 hard macro `sky130_sram_2kbyte_1rw1r_32x512_8`
  (683.1 × 416.54 µm). Flat instance names (`u_bank0.u_sram` … `u_bank7.u_sram`)
  for clean `MACRO_PLACEMENT_CFG` reference. Verilator lint clean.
- **PD config:** `pd/openlane/config.macro-array.sky130.json` — SKY130A, die
  3600 × 2200 µm, 8 hard macros (~33% macro area), CLOCK_PERIOD 15 ns,
  real SRAM LEF/LIB/GDS. OpenLane 2.4.0.dev1, native toolchain.
- **Tool note:** signoff Magic DRC flattens each SRAM's internal bitcell array
  (~400k shapes × 8) and is pathologically slow; candidate runs set
  `MAGIC_DRC_USE_GDS=false` (LEF-abstract DRC). The SRAM macro is PDK-verified
  DRC-clean, so abstract DRC is sound for a placement study. All PPA numbers
  below are **post-detailed-route** (OpenLane step 62, `Checker.XOR` state),
  identical extraction across all three placements.

## Placements compared

Each placement is a `MACRO_PLACEMENT_CFG` (fixed macro positions); the stdcell
glue, PDN, CTS, and routing are run identically. This is the candidate-replay
mechanism the `plan_macro_placement_replay.py` harness emits.

- `macro_array_baseline.cfg` — 4 columns × 2 rows, evenly spread.
- `macro_array_cand_compact.cfg` — 4 × 2 packed tightly toward the lower-left.
- `macro_array_cand_stack2x4.cfg` — 2 columns × 4 rows.

## Post-route results

| Placement | Route WL (est, µm) | Route DRC (iter1) | Setup WS (ns) | Setup TNS (ns) | Hold WS (ns) | Antenna nets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline 4×2 grid | 677,027 | 434 | −0.695 | −9.997 | +0.417 | 3 |
| compact 4×2 tight | **523,180** | 689 | −0.731 | −5.703 | +0.491 | 2 |
| stack 2col × 4row | 531,709 | **429** | **−0.310** | **−1.012** | +1.070 | 7 |

Deltas vs baseline:

- **compact:** −22.7% wirelength, +43% setup TNS (less negative), but +59%
  route DRC (tight packing raises local congestion) — a genuine trade-off, the
  kind E1-PL-010's negative-result archive is meant to capture.
- **stack 2×4:** −21.5% wirelength, **−90% setup TNS** (−9.997 → −1.012), best
  WNS, lowest route DRC, but +4 antenna nets.

## Findings

1. Macro placement materially changes E1 post-route PPA. The spread 4×2 baseline
   is worst on both wirelength and timing; both alternatives shorten wirelength
   ~22% and the 2×4 stack nearly closes the timing gap (TNS −9.997 → −1.012).
2. Wirelength and congestion can move in opposite directions (compact wins
   wirelength but loses routability), confirming that a proxy (HPWL) winner is
   not automatically a post-route winner — exactly why deterministic OpenLane
   replay remains the authority, not the proxy score.
3. None of the three placements is yet timing-clean (all have negative setup
   slack at 15 ns); the 2×4 stack is closest. This is a real optimisation target
   a trained placement policy can now be scored against.

## Status / how to reproduce

```sh
# baseline (full signoff; slow Magic DRC on SRAM internals)
openlane --pdk-root external/pdks pd/openlane/config.macro-array.sky130.json
# candidates (LEF-abstract DRC, completes fast)
openlane --pdk-root external/pdks pd/openlane/config.macro-array.compact.sky130.json
openlane --pdk-root external/pdks pd/openlane/config.macro-array.stack2x4.sky130.json
```

Metrics extracted from each run's `62-checker-xor/state_out.json`; saved under
`build/ai_eda/macro_array_ppa/{baseline_4x2,compact,stack2x4}.json` (ignored).

This is post-route PPA evidence for a SKY130 proxy design only. It is not a
phone-SoC, advanced-node, or silicon claim. The next step is to wire this real
case into `eda.placement_case.v1` so the trained macro-placement policy
generates the candidate cfgs directly and is scored on this post-route delta.
