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

1. **ORFS post-route** (full PnR) — drives `big_core_shell`, `npu_tile`,
   `slc_slice`, `npu_tile_rf_leaf`. Gated by an ORFS local checkout or docker
   image. The operator runs ORFS for the block and copies the post-route
   shape JSON into `docs/evidence/process/asap7/<block>_shape.json`.
2. **Yosys + ABC synth-only** (no ORFS dependency) — drives `tage_table` and
   any other leaf block whose `config.asap7.yaml` entry sets
   `flow_mode: yosys_abc_synth_only`. The runner invokes
   `scripts/run_asap7_leaf_synth.py`, which:
     1. unpacks the ASAP7 7p5t RVT TT NLDM libraries from
        `external/pdks/asap7/asap7sc7p5t_27/LIB/NLDM/*.lib.7z` into
        `build/asap7/lib/` (via `scripts/extract_asap7_libs.py` + the
        bundled `py7zr`),
     2. runs `yosys 0.64 + slang` with the per-block `synth_params`
        overrides,
     3. ABC-maps the design with `abc -fast` and the ORFS-published
        `DONT_USE_CELLS` exclusion set
        (`*x1p*_ASAP7*`, `*xp*_ASAP7*`, `SDF*`, `ICG*`),
     4. emits a shape JSON tagged
        `evidence_class: predictive_finfet_shape_only_not_signoff` that the
        downstream `scripts/project_ppa_to_n2p.py` ingests verbatim.

```sh
make -C pd/asap7 check                          # preflight: PDK reachable?
make -C pd/asap7 clone-asap7                    # one-shot ASAP7 PDK clone
make -C pd/asap7 clone-orfs                     # one-shot ORFS clone (tier-1 blocks)
make -C pd/asap7 all                            # run every ORFS block
make -C pd/asap7 leaf-shape MODULE=tage_table   # yosys+ABC synth-only leaf shape
make ppa-projection                             # project all shapes to N2P/A14/Intel-14A/SF2P
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

- **Tier 1 — Wrapper blocks** (`big_core_shell`, `npu_tile`, `slc_slice`)
  drive the existing module tops and emit a `*_shape.json` post-route shape
  report under `docs/evidence/process/asap7/`.
- **Tier 2 — Leaf sub-blocks** (`npu_tile_rf_leaf`) characterize a single
  representative sub-block (the first 64-entry NPU register-file slice
  inside `e1_npu`). Outputs are tagged `leaf_only` so they are not aggregated
  into top-level NPU area. The intent is to land a first sub-block shape
  before the full tile closes.

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
