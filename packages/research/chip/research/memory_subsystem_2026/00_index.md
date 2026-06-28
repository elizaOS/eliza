# Memory Subsystem Research Packet

Date: 2026-05-19

This packet records a source-backed survey of mobile and AI-accelerator memory
hierarchy literature for a 2028 14A-class mobile AI SoC. Scope covers external
DRAM (LPDDR5X, LPDDR6, HBM3E/HBM4), advanced fabric standards (CXL 3.x, CHI,
TileLink), open NoC RTL, near-/in-memory compute, sub-3 nm SRAM macro design,
cache coherency for accelerators, framebuffer/feature-map compression, DRAM
simulators, RowHammer and on-die ECC, and AI-SoC scratchpad/Buffets practice.

The contract anchors are:

- `docs/arch/memory-subsystem.md`, `docs/arch/interconnect.md`, `docs/arch/memory-map.md`
- `docs/spec-db/npu-2028-target.yaml`: ≥64 MiB local NPU SRAM, ≥20 TB/s local SRAM
  bandwidth, ≥32 MiB shared system cache, ≥180 GB/s external DRAM peak bandwidth,
  ≥120 GB/s sustained, compression-aware DMA, cache-coherent CPU submission, QoS
  across camera, display, audio, modem, and NPU.
- `docs/architecture-optimization/compute-silicon.md`: 208 GB/s sustained memory
  target (P1), gated by real benchmark evidence.

## Files

- `01_sources/source_inventory.yaml`: provenance, claim boundaries, and tags for
  every referenced specification, paper, vendor brief, and open RTL repository.
- `02_analysis/lpddr_and_dram_2026.md`: LPDDR5X, LPDDR6, HBM3E/HBM4 landscape;
  channel, burst, and bandwidth math for a mobile AP.
- `02_analysis/sram_and_local_memory.md`: 14A-class SRAM density, NPU local
  scratchpad budget, MRAM/eDRAM/gain-cell tradeoffs.
- `02_analysis/coherency_and_noc.md`: TileLink, AMBA CHI/ACE, CXL.cache, open
  NoC RTL, AI-SoC coherent fabric patterns.
- `02_analysis/bandwidth_compression_and_qos.md`: feature-map compression,
  compression-aware DMA, framebuffer compression, QoS classes for the mobile AP.
- `03_implementation/memory_path_for_e1.md`: ranked recommendations tied to the
  current scaffold, the 2028 target, and `docs/arch/memory-subsystem.md`.

## Claim Boundary

This is a research and planning packet. Every numeric value taken from a vendor
brief, JEDEC abstract, or academic paper is treated as a target or directional
data point. No claim about the current E1 implementation depends on this packet;
those claims must come from the existing RTL, cocotb, synthesis, and benchmark
evidence gates. Where a referenced standard or product is not publicly final
(LPDDR6 JESD209-6, HBM4 JESD238, Rubin memory configurations) the packet states
the status explicitly.
