# CTS — Clock-Tree Synthesis Strategy

The clock distribution methodology is split between the open-tooling MVP
(today) and the advanced-node closure (BLOCKED on commercial EDA).

## MVP (open PDKs, Sky130 + IHP SG13G2): TritonCTS H-tree

`cts_strategy.tcl` drives OpenROAD's TritonCTS to build a per-root H-tree with
a uniform skew target. This is sufficient at 130 nm where the clock period
floor is on the order of 5 ns and the worst-case useful-skew window is wide
relative to the on-chip variation budget. The configuration is intentionally
narrow:

- One clock root (`CLK_IN`), one buffer list, one target skew.
- No clock mesh.
- No concurrent clock-data optimization (CCOpt-equivalent).

That is appropriate at this node and **completely insufficient** at the
2028 target node. See below.

## Advanced node (Stage 3, BLOCKED on commercial EDA)

At N3/N2 the required CTS methodology is:

- **CCOpt or ClockMesh** for the top-level clock distribution: the analytical
  solver optimizes the data path and the clock tree concurrently rather than
  treating CTS as a separate pass. This typically saves 10-15 % power and
  closes setup/hold corners that TritonCTS cannot reach.
- **Mesh + leaf H-tree hybrid:** the top of the tree is a low-skew mesh, and
  each leaf cluster gets a local H-tree. This bounds OCV impact under POCV/SOCV
  with LVF and is the only viable approach for chips with multi-GHz clocks
  and >100k flops in one domain.
- **Useful-skew scheduling** integrated with the placer so flops near the
  critical path receive intentionally delayed clocks. Open tooling cannot do
  this end-to-end today.

These features are BLOCKED on the commercial EDA gate (Innovus / Fusion
Compiler / Genus + Tempus). See `docs/evidence/pd/commercial-eda-gate.yaml`.

## Why we still bring up TritonCTS now

The methodology-validation discipline matters more than the tool:

- The OpenLane Sky130 release must produce a real clock tree with measurable
  insertion delay and skew so the multi-corner STA wrapper has something to
  evaluate.
- Every clock-tree change (root buffer choice, fanout target, tolerance) we
  make on Sky130 produces a delta we can compare against in the advanced-node
  flow once it lights up.
- The `cts-evidence.yaml` gate enforces that we capture `cts_summary.rpt`
  from each release run.

## Acceptance for MVP

- `cts_summary.rpt` exists under `final/reports/` of every release run.
- TritonCTS reports skew within `CTS_TOLERANCE`.
- Multi-corner STA picks up the same clock root and produces non-zero
  insertion delay.
- No max-slew violations on the clock net at the slow corner.
