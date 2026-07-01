# E1X3D 3D-Stacked Wafer-Mesh Architecture

E1X3D is tracked as a **parallel** chip direction to E1X and E1. E1 is the
Ariane/CVA6-derived phone SoC path; E1X is the planar Cerebras-style wafer mesh;
**E1X3D is the 3D-stacked wafer mesh** — the same array of tiny RV64 processing
elements, made physically small in X/Y by stacking tiers (tall in Z), packed
tighter, with a fabric that routes around defective cores, links, inter-tier
(Z) links, and dead-tier regions.

The architecture model lives in `compiler/runtime/e1x3d_wafer_model.py`; the
3D-placement feasibility model in `compiler/runtime/e1x3d_placement_model.py`;
the 3D fabric RTL in `rtl/e1x3d/`. The research foundation and committed design
decisions are under `research/threed_ic_2026/`.

## Why 3D, and what is proven vs novel

The two research analyses (`research/threed_ic_2026/02_analysis/`) establish the
governing fact: **the X/Y wafer-scale mesh is Cerebras-proven; the Z tier-stack
is the novel, thermally-limited, lower-TRL part.** E1X3D keeps the two concerns
separate. Its 3D wins over planar E1X are:

- **More cores per wafer**: stacking `logical_tiers` logic planes multiplies core
  count (2x at the baseline two-tier point).
- **More local SRAM per core**: folding `memory_tiers_per_core` SRAM tiers onto
  each logic tier multiplies per-core memory without growing XY (48 KiB -> 96 KiB
  at the baseline).
- **Tighter XY packing**: moving SRAM off the logic plane shrinks the per-core
  footprint ~36-64% (Open3DBench-grounded, not a naive 2x/tier).

The scaled point (`scaled_e1x3d_config`) is an E1X-class 512 x 342 per-tier mesh
x 2 logic tiers = **350,208 logic cores (2x E1X)**, **32 GiB distributed SRAM
(4x E1X)**, at **3.125x planar packing density** (2 logic tiers / (1 - 0.36 XY
footprint shrink); the 0.36 shrink is derived by the block SRAM-on-logic split in
`compiler/runtime/e1x3d_placement_model.py`, not assumed).

## Current E1X3D contract

- ISA target: tiny `rv64imafdc_zicsr_zifencei`-class RISC-V core array (same PE
  as E1X).
- Topology: 3D mesh. Each logical core is `Coord3(row, col, tier)`. In-plane
  N/E/S/W links plus inter-tier UP/DOWN links between adjacent logic tiers.
- Tier model: memory-on-logic. `logical_tiers` logic tiers (default 2, thermal
  hard max 4); each logic tier carries `memory_tiers_per_core` folded SRAM tiers
  (default 1). Total physical Z tiers = `logical_tiers * (1 + memory_tiers_per_core)`.
- Bonding: `hybrid_bond_f2f` (default, block-level SRAM-on-logic) or
  `monolithic_miv` (fine per-PE logic folding). The placement model checks the
  tier split's inter-tier via density against a bonding catalog.
- Fabric direction encoding reuses the E1X 3-bit field
  (`rtl/e1x/e1x_pkg.sv`): NORTH=0, EAST=1, SOUTH=2, WEST=3, LOCAL=4, **UP=5,
  DOWN=6**, DROP=7. The repair-ROM route word already carries a 3-bit first-hop
  direction, so 3D routes need **no ROM/encoding format break**.
- Defect flow: deterministic 3D defect-map generation (cores, in-plane links,
  Z links, and bounded dead-tier regions); logical-to-physical repair via spare
  rows, columns, and planes; 3D A* route validation over normal, high-failure,
  and dead-tier-region scenarios.
- Repair handoff: the scaled generator writes an
  `eliza.e1x3d.wafer_sort_defect_map.v1` sidecar, an
  `eliza.e1x3d.repair_manifest.v1` (remapped cores + sampled 3D routes), an
  `eliza.e1x3d.repair_rom.v1` 64-bit word image (+ `.hex`) with a 3D magic
  (`E13DREPR`) and a tier field, plus `eliza.e1x3d.thermal_model.v1` and
  `eliza.e1x3d.stack_yield_model.v1` sidecars.
- Repair ROM RTL: the verified PORTS-parametric `rtl/e1x/e1x_mesh_router.sv`
  instantiates as a **7-port 3D router** (proven in cocotb to forward UP/DOWN and
  repair-drop a disabled Z link); `rtl/e1x3d/e1x3d_tile.sv` wires the six
  neighbor ports plus the local core. The repair ROM loader/route-table/MMIO
  stack carries the 3-bit UP/DOWN directions unchanged.
- Thermal: a stacked-logic ceiling gate (Open3DBench +~10% peak temp per extra
  logic tier, NSF ~1.0 W/mm2 per-tier ceiling, dual-sided cooling rise
  reduction). Fails closed above 4 logic tiers, over the power-density ceiling,
  or over the junction-temperature ceiling.
- Stack yield: per-core Poisson core yield, multiplicative bond yield across the
  Z and memory-tier bonds, spare-plane repair feasibility, D2W + KGD/KGS + IEEE
  1838 test assumption. Fails closed when spares cannot cover defects or bond
  yield falls below target.

## Evidence commands

```sh
make e1x3d-wafer-stack-evidence     # base 3D stacked-mesh report
make e1x3d-scaled-model-evidence    # scaled 350k-core report + repair/thermal/yield sidecars
make e1x3d-placement-evidence       # 3D-placement feasibility (footprint shrink, via budget)
make e1x3d-model-test               # architecture-model pytest
make e1x3d-benchmark                # fail-closed benchmark gate (repair + thermal + yield + comparison)
make e1x3d-placement                # placement-feasibility gate
make e1x3d-fabric-cocotb            # 7-port 3D router cocotb gate (UP/DOWN + Z-link repair)
```

## Evidence scope / claim boundary

This is **architecture-simulation evidence only**. It demonstrates 3D SRAM
sizing, tier-stacked core/SRAM scaling, tighter XY packing, deterministic 3D
defect-map generation, spare-row/column/plane repair, 3D A* route validation
including inter-tier and dead-tier-region routing, repair-manifest/ROM handoff
with 3D directions, a stacked-logic thermal-ceiling gate, a multiplicative
stack-yield gate, and a 7-port 3D router RTL proof. It does **not** claim RTL
completion, PDK signoff, 3D DRC/LVS, electrothermal or SI/PI signoff, a
sequential-integration (monolithic-3D) PDK, physical wafer sort, package or
warpage feasibility, or measured silicon.

## Completion gates still missing

- Full per-tier RV64 PE RTL and a production 3D mesh router with queues,
  inter-tier credit flow, and formal deadlock freedom across the Z dimension.
- Dead-tier-aware Z routing as RTL/firmware (graceful column degradation when a
  whole logic tier is lost), beyond the current bounded dead-tier-region repair
  model and the spare-plane requirement that fails closed at wafer scale.
- A spare-plane (`spare_tiers >= 1`) budget and harvesting policy for full
  dead-tier repair at scale.
- Real 3D placement on Open3DBench / OpenROAD-Research (Pin-3D / Snap-3D) with
  DREAMPlace, and thermal co-analysis on HotSpot / 3D-ICE.
- **Commercial 3D signoff (BLOCKED, no open path)**: 3D DRC/LVS, electrothermal,
  and SI/PI require Cadence Integrity 3D-IC + Celsius / Sigrity, Synopsys 3DIC
  Compiler + 3DSO.ai + RedHawk-SC Electrothermal, or Siemens Calibre 3D-LVS/DRC.
- Inter-tier interconnect characterization (MIV vs hybrid-bond R/C, KGD test
  cost) and a sequential-integration PDK for any fine per-PE logic fold.
- Measured benchmark evidence against E1X on FPGA, board, or silicon.

See `docs/risks/e1x3d-risks.md` for the ranked risk register.
