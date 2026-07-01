# ASAP7 predictive 7 nm flow — FinFET-class PPA shape projection

## What this is

ASAP7 is a **predictive academic** 7 nm FinFET PDK developed by ASU + ARM
([arxiv 1708.02078](https://arxiv.org/abs/1708.02078), source on
[GitHub](https://github.com/The-OpenROAD-Project/asap7)). It is the only open
PDK that uses FinFET-era device physics, multi-Vt cell families, 7.5T cell
heights, and sub-7-nm interconnect parasitics.

ASAP7 is **not manufacturable**. No foundry accepts ASAP7 GDS. ASAP7's role in
this repo is exactly one thing: produce **PPA shapes** (timing, power, area,
congestion) on FinFET-class device physics so the rest of the project can
project those shapes to TSMC N2P / A14 / Intel 14A class using
`scripts/project_ppa_to_n2p.py` with published vendor scaling factors.

## Why we run it

- Open-PDK lane (Sky130A, GF180MCU, IHP SG13G2) gives real DRC/LVS but the
  device physics is planar 130 nm. Timing, power, and SRAM density numbers do
  not translate up the node ladder.
- Commercial signoff at N2P / A14 / 14A is blocked until foundry agreement
  (see `pd/n2p-stub/`, `pd/a14-stub/`, `pd/intel-14a-stub/`).
- ASAP7 closes the gap between "we have real PD methodology" and "we know what
  the FinFET-class shape of our blocks looks like."

## Constraints

- All ASAP7 output is **`projection_only`**. Every report emitted by this flow
  has `evidence_class: predictive_finfet_shape_only_not_signoff`.
- No TSMC N2P / A14 / Intel 14A signoff claim may cite ASAP7 numbers without
  applying the vendor scaling factors documented in
  `docs/pd/process-node-selection.md` and emitting the result through
  `scripts/project_ppa_to_n2p.py`.
- ASAP7 SRAM is predictive only. SLC / L2 / NPU local SRAM sizing must use
  published vendor SRAM density (TSMC N2 38.1 Mb/mm² HD macro), not ASAP7.
- ASAP7 is not under any release-evidence gate. It is shape input.

## Flow

Two flow modes coexist in this lane:

1. **Yosys + ABC synth-only** (no ORFS dependency, default) — drives every
   block currently declared in `config.asap7.yaml`: `tage_table`,
   `npu_tile_rf_leaf`, `npu_tile`, `big_core_shell`, `slc_slice`. The runner
   invokes `scripts/run_asap7_leaf_synth.py`, which:
     1. unpacks the ASAP7 7p5t RVT TT NLDM libraries from
        `external/pdks/asap7/asap7sc7p5t_27/LIB/NLDM/*.lib.7z` into
        `build/asap7/lib/` (via `scripts/extract_asap7_libs.py` + the
        bundled `py7zr`),
     2. runs `yosys 0.64 + slang` with the per-block `synth_params`
        overrides and the per-block `rtl_top` as the SystemVerilog top,
     3. ABC-maps the design with `abc -fast` and the ORFS-published
        `DONT_USE_CELLS` exclusion set
        (`*x1p*_ASAP7*`, `*xp*_ASAP7*`, `SDF*`, `ICG*`),
     4. emits a shape JSON tagged
        `evidence_class: predictive_finfet_shape_only_not_signoff` that the
        downstream `scripts/project_ppa_to_n2p.py` ingests verbatim.
2. **ORFS post-route** (full PnR, opt-in) — available for any block whose
   `config.asap7.yaml` entry omits `flow_mode: yosys_abc_synth_only`. Gated
   by an ORFS local checkout or docker image. The operator runs ORFS for the
   block and copies the post-route shape JSON into
   `docs/evidence/process/asap7/<block>_shape.json`. No block currently
   ships with this mode by default; it is the upgrade path once full PnR
   is required for a leaf.

```sh
make -C pd/asap7 check                              # preflight: PDK reachable?
make -C pd/asap7 clone-asap7                        # one-shot ASAP7 PDK clone
make -C pd/asap7 clone-orfs                         # one-shot ORFS clone (opt-in PnR)
make -C pd/asap7 leaf-shape MODULE=tage_table       # yosys+ABC synth-only leaf shape
make -C pd/asap7 leaf-shape MODULE=npu_tile_rf_leaf # NPU weight-buffer SRAM leaf shape
make -C pd/asap7 leaf-shape MODULE=npu_tile         # full e1_npu monolithic tile shape
make -C pd/asap7 leaf-shape MODULE=big_core_shell   # CPU subsystem stub leaf shape
make -C pd/asap7 leaf-shape MODULE=slc_slice        # SLC bank slice shape (shrunk geom)
make -C pd/asap7 big_core_shell-shape               # equivalent per-block target
make ppa-projection                                 # project all shapes to N2P/A14/Intel-14A/SF2P
```

The block list is defined in `config.asap7.yaml` and mirrors the OpenLane
top-level RTL set. Each block is run separately because ASAP7 is intended for
per-block shape characterization, not flat top-down closure.

### Reproducing the round-3 `tage_table` leaf shape

```sh
make -C pd/asap7 clone-asap7                   # ~1 min net, ~1.3 GB disk
make -C pd/asap7 leaf-shape MODULE=tage_table  # ~10 s yosys+ABC
make ppa-projection                            # ~3 s per-block Monte Carlo
```

Outputs:

- `docs/evidence/process/asap7/tage_table_shape.json` — ABC-mapped gate
  count, std-cell area, cell histogram. Tagged
  `evidence_class=predictive_finfet_shape_only_not_signoff`.
- `docs/evidence/process/asap7/tage_table_projection_n2p.json` — Monte
  Carlo p10 / p50 / p90 area bands across N2P, A14, Intel 14A, Samsung SF2P
  (1-sigma scaling-factor uncertainty from `ppa-projection.yaml`).
- `docs/evidence/process/ppa-projection.json` — aggregated multi-block
  projection report.

Wall-clock budget on a single workstation: ~10 s for the synth, ~3 s for
projection (dominated by 4096-sample Monte Carlo × four targets).
The 4096-entry production geometry of `tage_table` is approximated by the
128-entry leaf-shape (`synth_params.ENTRIES=128`) so the lookup/update
control path is the same while the flat-flop storage cost stays tractable.
Storage area scales linearly with `ENTRIES`; consumers projecting the full
production geometry should multiply `sequential_cells × area-per-DFF` by
`(production / leaf)` and add it to the (entry-count-invariant) combina-
tional logic area.

### Block tiers

Every block currently uses the yosys + ABC synth-only flow. The block list
mirrors the per-domain leaf shape needed for advanced-node area projection:

- **`tage_table`** — BPU TAGE tagged-table primitive (128-entry leaf-shape
  proxy of the production 4096-entry geometry).
- **`npu_tile_rf_leaf`** — NPU weight-staging register file
  (`e1_weight_buffer_sram`, 512x32-bit + write-mask, behavioral path). The
  hard-macro swap point under `E1_HAVE_HARD_SRAM`.
- **`npu_tile`** — full `e1_npu` monolithic NPU tile (16x32-bit scratch RF,
  16 opcodes including INT8/INT4/INT2/FP8 dot products, GEMM/vector engines,
  AXI-Lite descriptor engine, perf counters) at production geometry.
- **`big_core_shell`** — `e1_cpu_subsystem_stub`, the self-contained
  32x64-bit RV64I subset in-order microcontroller stub (decoder + ALU +
  architectural RF + AXI4-Lite master FSM). Substitutes for the
  Kunminghu / CVA6 big-core RTL until those land.
- **`slc_slice`** — shrunk `e1_slc` (2 KiB, 2-way, 2 banks, 64 B line)
  covering the cache lookup/install FSM, BDI compression form classifier,
  QoS-aware victim selection, and display-RT reservation counter.

For every block, the storage cost in the leaf shape is the flat-flop cost.
Production silicon swaps storage for vendor SRAM macros at vendor density
(38.1 Mb/mm² HD at N2 per TSMC) — `scripts/project_ppa_to_n2p.py` carries
the logic-only band; reviewers must add macro area separately when sizing
real cache or scratch arrays.

### Fail-closed contract

Each block runs through `scripts/run_asap7_block.sh`, which:

1. Verifies `external/pdks/asap7` exists, otherwise emits `BLOCKED:` with the
   clone command and exits 1.
2. Verifies an ORFS path is reachable (either `ORFS_FLOW_HOME` local checkout
   or a docker image), otherwise emits `BLOCKED:` and exits 1.
3. Confirms the block id is declared in `config.asap7.yaml`.
4. After ORFS post-route, verifies the operator-produced shape JSON carries
   `evidence_class: predictive_finfet_shape_only_not_signoff` and
   `pdk: ASAP7`; rejects anything that misses the tag.

No partial / silent / placeholder evidence is ever emitted.

## Outputs

Every shape report includes:
- `evidence_class: predictive_finfet_shape_only_not_signoff`
- `pdk: ASAP7`
- the ASAP7 stdcell pitch + Vt mix used
- max-frequency shape (timing-clean target clock)
- standard-cell area
- dynamic-power-per-MHz from activity-driven flow when available
- static leakage at FF / TT / SS corners

These shape reports are consumed downstream by:
- `scripts/project_ppa_to_n2p.py` (apply vendor scaling factors to project N2P)
- `docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml`
  (informational only, never as signoff)

## What ASAP7 cannot tell us

- Real foundry yield, defect density, or sigma corner data.
- Real SRAM macro density (use vendor 38.1 Mb/mm² at N2 instead).
- Real LPDDR / MIPI / USB PHY area or power.
- Real PowerVia / BSPDN behavior.
- Real BTI / HCI / TDDB / EM lifetime.
- Real High-NA EUV DFM tradeoffs.
- Any number that could replace commercial signoff at the production node.
