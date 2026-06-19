# CTS Strategy — TritonCTS MVP, CCOpt at Advanced Node

## Scope

This document records the clock-tree synthesis strategy at the open PDK
stage (Sky130 + IHP SG13G2) and at the 2028 advanced-node target. It is the
human-readable companion to `docs/evidence/pd/cts-evidence.yaml`.

## MVP (open PDKs): TritonCTS H-tree

- **Tool:** OpenROAD `clock_tree_synthesis` (TritonCTS).
- **Config:** `pd/cts/cts_strategy.tcl`.
- **Topology:** per-root H-tree with uniform skew target.
- **Buffer ladder:** `clkbuf_4`, `clkbuf_8`, `clkbuf_16` from
  `sky130_fd_sc_hd`. Root buffer `clkbuf_16`.
- **Skew tolerance:** 100 ps relative target with a 200 ps useful-skew
  window.

Acceptance evidence: `cts_summary.rpt` under `final/reports/` of every
release run, showing skew within tolerance and zero max-slew violations on
the clock net at the slow corner.

This is **enough** at 130 nm. It is **not** enough at the 2028 target node.

## Advanced node (Stage 3, BLOCKED on commercial EDA)

| Concern | TritonCTS (today) | Required at N3/N2 |
| --- | --- | --- |
| Top-level distribution | H-tree | low-skew **mesh** with leaf H-tree |
| Concurrent CT-data optimization | none | **CCOpt** or equivalent |
| Useful-skew scheduling | static | placer-coupled, per-flop |
| OCV/POCV-aware sizing | uniform | per-stage with LVF Liberty |
| Multi-domain handling | single root | crossing-aware, drift-bounded |

The commercial-EDA gate (`docs/evidence/pd/commercial-eda-gate.yaml`)
captures the missing tool stack: Innovus or Fusion Compiler for CTS, Tempus
or PrimeTime for signoff, Voltus or RedHawk-SC for power-aware CTS.

## Methodology validation discipline

Even though TritonCTS does not solve the advanced-node problem, we exercise
it now because:

1. The OpenLane Sky130 release must produce a real clock tree with
   measurable insertion delay and skew so multi-corner STA has something to
   evaluate.
2. Every CTS knob (root buffer choice, fanout cap, tolerance) we set on
   Sky130 produces a delta that informs the advanced-node flow.
3. The methodology discipline (skew capture, multi-corner check, max-slew
   audit) is exactly what scales to CCOpt; only the tool changes.

## What unblocks the cts-evidence gate

For Stage 1 (MVP, open PDK):

- `cts_summary.rpt` is captured for every release run.
- TritonCTS reports skew within `CTS_TOLERANCE`.
- Multi-corner STA picks up the clock root insertion delay.
- No max-slew violations on the clock net at SS.

For Stage 3 (advanced node):

- Commercial-EDA gate unblocks.
- CCOpt or Fusion Compiler concurrent clock-data optimization runs cleanly.
- Mesh + leaf H-tree topology produces a routed clock with bounded OCV
  contribution under POCV/SOCV+LVF.
