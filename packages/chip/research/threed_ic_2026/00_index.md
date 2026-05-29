# 3D-IC / E1X3D Research Index (2026)

Research backing the **E1X3D** chip direction: a Cerebras-style wafer-scale RISC-V
mesh whose processing elements are made physically small in X/Y by stacking tiers
(tall in Z), then packed tighter, with a fabric topology that routes around
defective cores, links, vias, and whole dead tiers.

E1X3D is tracked as a **parallel** direction to E1X (the planar wafer-mesh path)
and E1 (the Ariane/CVA6 phone SoC path). The architecture model lives in
`compiler/runtime/e1x3d_wafer_model.py`; the design doc is
`docs/arch/e1x3d-wafer-stack.md`.

## Contents

- `02_analysis/3d_ic_eda_flows_and_tools.md` — 3D integration styles (M3D / TSV /
  hybrid-bond / wafer-scale), open vs commercial 3D PD flows, thermal co-analysis,
  inter-tier interconnect electrical/yield rules, IEEE 1838 DfT.
- `02_analysis/3d_placement_benchmarks_yield_thermal.md` — 3D placement algorithms
  (tier partitioning, analytic ePlace-3D/DREAMPlace, thermal-aware, ML/RL,
  per-core folding), 3D-IC benchmarks/contests (Open3DBench, Pin-3D, ICCAD),
  Cerebras wafer-scale defect tolerance, yield/KGD/reliability, thermal limits.
- `03_implementation/e1x3d_design_decisions.md` — the concrete, checked design
  decisions for E1X3D distilled from the two analyses, with the fail-closed gates
  that bound each unproven claim.

## Headline conclusions that bound the E1X3D design

1. **The X/Y wafer-scale mesh is Cerebras-proven; the Z tier-stack is the novel,
   thermally-limited, lower-TRL part.** Keep the two concerns separate.
2. **"Tall Z full of active logic" is contraindicated.** Data supports a *short*
   stack: 2 logic tiers (4 max), memory/SRAM tiers as thermal buffers, route
   around everything, cool from both sides. Two-tier folding buys ~40-50% XY
   shrink (not a naive 2x/tier) at ~+10% peak temperature.
3. **Only monolithic-3D (MIV, ~70 nm, <1 fF, ~30M/mm2) is fine enough to split a
   single small PE across tiers; it is research-grade and thermally capped at
   2-4 tiers.** Production hybrid bonding (SoIC ~6 um) only stacks whole blocks
   (SRAM-on-logic, the 3D V-Cache pattern). E1X3D must declare which split it
   targets, because that choice sets the feasibility risk.
4. **There is no open-source 3D signoff path** (3D DRC/LVS, electrothermal, SI/PI
   are commercial-only). Open prototyping = ORFS-Research / Open3DBench / Pin-3D
   + 3D-ICE/HotSpot. Every signoff-grade claim is a fail-closed `BLOCKED` gate.
5. **Yield compounds multiplicatively across tiers; use D2W + KGD/KGS and ~1.5%
   fine-grained spares per tier plus spare planes.** Dead-tier-aware Z routing
   (graceful column degradation) is the true research gap E1X3D owns.
