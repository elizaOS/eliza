# 14A / Sub-2 nm Process Notes For AI Accelerators

Date: 2026-05-19

## Public Process Direction

Intel's public AI/HPC foundry brief describes:

- 18A: RibbonFET gate-all-around transistors and PowerVia backside power.
- 18A-P: optimized ribbon sizes and threshold-voltage options.
- 18A-PT: 3D integration base-die direction with TSV and hybrid-bonding support.
- 14A: RibbonFET 2, PowerDirect backside power, Turbo Cells, and improved
  performance per watt/density versus 18A.
- EMIB/Foveros Direct: multi-die and 3D packaging paths for AI/HPC scale.

Google, NVIDIA, Qualcomm, and MediaTek public products demonstrate that even
before 14A-class nodes, SOTA AI depends on packaging, memory, power delivery,
cooling, and software scheduling.

## Architectural Effects

### Power Delivery Becomes A Datapath Constraint

Backside power delivery reduces IR drop and frees frontside routing, but the E1
architecture still needs:

- per-block current estimates for tensor arrays, SRAM, DMA, interconnect, CPU,
  GPU/display, and memory PHY;
- transient droop models for bursty GEMM/attention phases;
- on-die decap planning tied to local NPU activity;
- power-aware placement of high-toggle arrays and SRAM banks.

### SRAM Scaling Is Not Free

At sub-2 nm, SRAM bitcell scaling, Vmin, retention, repair, ECC, and soft-error
behavior can dominate the practical local-memory plan. E1 should avoid assuming
that a large monolithic NPU SRAM is cheaper than a banked scratchpad, cache, or
chiplet/package memory split.

### Self-Heating And Aging Need Early Margins

Sub-3 nm reliability literature reports that self-heating and aging can create
large end-of-life timing degradation, especially in dense AI accelerator blocks.
E1 needs:

- thermal-density limits in the tile scheduler,
- activity-aware floorplanning,
- aging-aware timing margin assumptions,
- telemetry counters for sustained use,
- DVFS and throttling hooks.

### Wire Delay And Congestion Dominate Large Arrays

Sub-2 nm transistors are fast, but global wires and SRAM ports remain expensive.
A giant flat systolic array is risky. Prefer:

- tiled arrays with local accumulator SRAM,
- short nearest-neighbor data movement,
- explicit DMA prefetch and double buffering,
- NoC-aware multi-tile scheduling,
- physically aware generator constraints.

### Packaging Defines Memory Bandwidth

HBM, LPDDR, UCIe, EMIB-like bridges, and future 3D memory-on-logic determine
sustained tokens/J. E1 should keep separate targets for:

- phone-class LPDDR package,
- FPGA/prototype DRAM,
- future 2.5D HBM chiplet package,
- future active-interposer or base-die integration.

## E1 Process Gates To Add

- `process_node_assumption`: one checked manifest per target node and package.
- `npu_ir_drop_budget`: block-level dynamic current and droop estimate.
- `npu_thermal_density_budget`: sustained array/SRAM heat map.
- `sram_vmin_ecc_repair_plan`: local memory reliability assumptions.
- `aging_derate_policy`: end-of-life timing derate for NPU and SRAM.
- `package_bandwidth_model`: LPDDR/HBM/UCIe bandwidth and energy per byte.
- `chiplet_yield_model`: reticle, redundancy, known-good-die, and test strategy.

## Do Not Claim Yet

- Any real 14A timing, density, power, or yield without a foundry PDK and
  characterized libraries.
- CIM energy gains without memory macro data.
- HBM-class bandwidth in the mobile package target.
- Sustained TOPS/W without thermal and package-power evidence.
