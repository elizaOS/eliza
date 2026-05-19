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

The expected flow is OpenROAD ORFS (the OpenROAD project flow), not OpenLane 2.
ORFS supports ASAP7 natively. The flow consumes the same `rtl/` source set as
the OpenLane lanes; only the PDK + cell library + clock target differ.

```sh
make asap7-flow              # invokes the ORFS docker entrypoint per block
make asap7-shape-report      # emits projection_only JSON shape per block
```

The block list is defined in `config.asap7.yaml` and mirrors the OpenLane
top-level RTL set. Each block is run separately because ASAP7 is intended for
per-block shape characterization, not flat top-down closure.

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
