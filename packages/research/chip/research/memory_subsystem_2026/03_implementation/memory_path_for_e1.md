# Memory path implementation plan for E1

Date: 2026-05-19

This document maps the research findings in `02_analysis/` into a ranked
implementation plan tied to:

- `docs/spec-db/npu-2028-target.yaml`: 2028 target gates.
- `docs/arch/memory-subsystem.md`: current scaffold and fail-closed gates.
- `docs/arch/interconnect.md`: current AXI-Lite fabric scaffold.
- `docs/arch/memory-map.md`: current memory map.
- `docs/architecture-optimization/compute-silicon.md`: 208 GB/s sustained
  memory target as P1.

Every recommendation below is gated on existing evidence files; nothing here
changes the RTL or the evidence gates. The current scaffold remains
fail-closed until each gate is satisfied with executable evidence.

## Current gap summary

| Surface | Current scaffold | 2028 contract |
| --- | --- | --- |
| External DRAM | 4 KiB SRAM-backed AXI-Lite at `0x8000_0000` | LPDDR6-class, 96-128 bit, >=180 GB/s peak, >=120 GB/s sustained |
| System cache | None | >=32 MiB SLC, coherent |
| Local NPU SRAM | 64 B scratchpad (16 words) in MMIO | >=64 MiB tiled, >=20 TB/s aggregate |
| Fabric | AXI-Lite single-beat, fixed CPU mux | TileLink-C or CHI-E/F coherent fabric, mesh NoC |
| IOMMU | None | SMMUv3 or RISC-V IOMMU, per-master stream IDs |
| Coherency | None | I/O coherent NPU with cache stash |
| QoS | None | 4+ priority classes, isochronous reservations |
| Compression | None | AFBC for display, compression-aware DMA for NPU |
| Refresh / RowHammer | n/a | TRR + RFM, on-die ECC, link CRC |
| Counters | DMA byte counters | Per-master and per-class bw/latency counters |

## P0 implementation order

The dependencies form a linear chain: fabric -> controller -> IOMMU -> SLC ->
DMA -> NPU SRAM. Each step's evidence gate must close before the next claim.

### P0.1 Replace AXI-Lite scaffold with TileLink-C or AXI4 + ACE-Lite fabric

Reference: `02_analysis/coherency_and_noc.md`.

- Choose TileLink-C if E1 CPU is RISC-V (Rocket / BOOM / CVA6); CHI-E if Arm.
- Replace `rtl/interconnect/e1_axi_lite_interconnect.sv` with a fabric that
  has IDs, bursts, channels, atomics, ordering domains, and backpressure.
- Add bridges from the new fabric to:
  - DRAM controller (NPU side)
  - MMIO (current peripheral / DMA / NPU registers)
  - SMMU/IOMMU control plane
- Cocotb tests: burst length, ID interleave, ordering, response attribution,
  atomics, and backpressure under contention.

Evidence gate: replaces the "production fabric gates" row in
`docs/arch/interconnect.md` once cocotb evidence is checked in.

### P0.2 LPDDR6 controller and PHY boundary (or supplier integration)

Reference: `02_analysis/lpddr_and_dram_2026.md`.

- Boundary spec: 96-128-bit LPDDR6 at 12.8-14.4 Gb/s per pin, on-die ECC,
  link CRC enabled, TRR + RFM RowHammer policy.
- For the first integration step a simulation-grade controller model (e.g.,
  Ramulator 2-driven testbench) is acceptable; an RTL controller requires
  third-party IP (open or commercial) and PHY hard-macro from the foundry.
- Add training transcripts, refresh policy, and discovered-memory-map evidence
  to `docs/evidence/memory/`.
- Replace the 4 KiB SRAM-backed `e1_axi_lite_dram.sv` with a simulator-backed
  DRAM controller wrapper for software boot, while preserving the existing
  `0x8000_0000` aperture base.

Evidence gate: `docs/evidence/memory/uma-dram-evidence-gate.yaml` capacity,
bandwidth, and latency rows.

### P0.3 SMMU / IOMMU integration

Reference: `02_analysis/coherency_and_noc.md`.

- Add SMMUv3 (Arm) or RISC-V IOMMU IP behind the new fabric.
- Assign per-master stream IDs: NPU command-DMA, NPU data-DMA, GPU, display,
  camera ISP, modem, audio DSP.
- Surface fault path through the existing interrupt controller (extended to
  PLIC/IMSIC scope per `docs/arch/interrupts.md` work).
- Cocotb negative tests: unauthorized DMA stream must fault and must not
  mutate target state.

Evidence gate: `docs/arch/memory-subsystem.md` "IOMMU/SMMU" row.

## P1 implementation order

### P1.1 Shared system cache (SLC) bank

Reference: `02_analysis/sram_and_local_memory.md`, `02_analysis/coherency_and_noc.md`.

- 32 MiB SLC, banked 4-8 ways, TileLink-C inclusive or CHI directory-coherent.
- Co-located with CPU, GPU, NPU on the NoC mesh.
- Cache stash entry point for command-queue submission.

Evidence gate: synthesized macro-level area within phone-class die budget,
SLC hit-rate evidence on AI workload traces, and cocotb-level coherence
checks.

### P1.2 NPU local SRAM at 64 MiB across 8-16 tiles

Reference: `02_analysis/sram_and_local_memory.md`.

- 4 MiB per tile, 8-bank multi-bank organization, SECDED ECC.
- Per-tile bandwidth >=1.25 TB/s at 16 tiles (8 banks x 64 B x 2.5 GHz) or
  >=2.5 TB/s at 8 tiles.
- Buffets-style organization: weight, activation, output, DMA staging
  partitions.
- Double-buffer (ping/pong) between DMA-fill and compute-consume.

Evidence gate: cycle-accurate NPU model with measured bank-conflict rate,
aggregate bandwidth, and SECDED counters under MLPerf-mobile-class traces.

### P1.3 Compression-aware DMA

Reference: `02_analysis/bandwidth_compression_and_qos.md`.

- Single canonical on-chip compression format: 64-element block, header word
  + bitmap, INT8/INT4/INT2 modes plus FP8 KV mode.
- Encode/decode at DMA boundary; tile-local SRAM stores expanded data.
- Per-channel compression mode and per-channel compressed/uncompressed byte
  counters.

Evidence gate: cocotb tests for each mode plus a bandwidth-savings number on
a reference workload (e.g., 2-3x bandwidth savings on ReLU-heavy MobileNet
feature maps, 2x on FP8 KV).

### P1.4 QoS policy in DRAM controller

Reference: `02_analysis/bandwidth_compression_and_qos.md`.

- 4 priority classes: Isochronous, High, Normal, Best-effort.
- Per-class reservation and cap programmable at boot.
- Ramulator 2 + DRAMsim3 simulation evidence with isochronous classes
  meeting p99 latency under contended workload.

Evidence gate: simulator report showing display, camera, modem, audio all
within p99 latency targets under maximum-contention AI+camera+display workload.

## P2 implementation order

### P2.1 RowHammer mitigation, ECC counters, and link CRC

Reference: `02_analysis/lpddr_and_dram_2026.md`.

- Enable TRR and RFM in the LPDDR6 controller.
- On-die ECC counters exposed to firmware via MMIO.
- Link CRC enabled for write and read paths; per-rank CRC error counters.
- Boot transcript captures RowHammer policy and counter starting state.

Evidence gate: power-on boot transcript and a row-hammer stress workload that
proves the counters update; no claim about absolute RowHammer immunity.

### P2.2 AFBC framebuffer compression for display path

Reference: `02_analysis/bandwidth_compression_and_qos.md`.

- Display controller and GPU implement AFBC (or successor) consistently.
- dma-buf modifiers carry the compression format end-to-end.
- Display underflow counters track compressed-vs-uncompressed savings.

Evidence gate: display contract update with AFBC throughput on the reference
4K 120 Hz HDR scenario.

### P2.3 Cache stash for command submission

Reference: `02_analysis/coherency_and_noc.md`.

- CHI cache stash hint or TileLink-C equivalent for CPU -> NPU command
  descriptor write.
- Measured command-submission latency: target <200 ns CPU-write-to-NPU-see.

Evidence gate: cocotb-level measurement of CPU-to-NPU command latency with
and without cache stash; the stash variant should win by 80-150 ns.

### P2.4 Always-on micro-NPU local memory (optional STT-MRAM track)

Reference: `02_analysis/sram_and_local_memory.md`.

- 1-2 MiB local memory for the always-on micro-NPU.
- Default: SRAM at 14A HD macro.
- Track: STT-MRAM at the same capacity if foundry library available; benefit
  is non-volatile retention for the 20 mW always-on budget.

Evidence gate: always-on power line item with SRAM vs MRAM baseline.

## What stays fail-closed

Until each P0/P1 step is completed with the evidence above, these claims must
fail closed in the repository (no edits required to this packet):

- `external_memory_bandwidth_gbps_min` (180 GB/s)
- `local_sram_mib_min` (64 MiB) and `local_sram_bandwidth_tbps_min` (20 TB/s)
- `shared_system_cache_mib_min` (32 MiB)
- `cache_coherent_cpu_submission`
- `iommu_isolated_command_buffers`
- `compression_aware_dma`
- `QoS_for_camera_display_audio_modem`

The existing `docs/evidence/memory/uma-dram-evidence-gate.yaml` is the
controlling artifact for the first three. The architecture-optimization work
order's 208 GB/s sustained memory target stays gated on real benchmark
evidence per `docs/architecture-optimization/compute-silicon.md`.

## Coverage matrix

| Target field | Document section |
| --- | --- |
| `external_memory_bandwidth_gbps_min: 180` | P0.2 LPDDR6 controller |
| `local_sram_mib_min: 64` | P1.2 NPU local SRAM |
| `local_sram_bandwidth_tbps_min: 20` | P1.2 NPU local SRAM |
| `shared_system_cache_mib_min: 32` | P1.1 SLC |
| `compression_aware_dma` | P1.3 DMA |
| `iommu_isolated_command_buffers` | P0.3 SMMU |
| `cache_coherent_cpu_submission` | P0.1 fabric + P2.3 cache stash |
| `QoS_for_camera_display_audio_modem` | P1.4 QoS policy |
| `ecc_or_parity_on_sram` | P1.2 (SECDED on tile SRAM and SLC) |
| `per_context_fault_isolation` | P0.3 SMMU + P1.4 QoS |
| `thermal_throttle_counters` | Outside this packet (compute / physical) |
| `performance_counter_virtualization` | Outside this packet (CPU subsystem) |

## What this packet does not claim

- It does not claim that any of the above is implemented in E1 RTL today.
- It does not claim a specific vendor for LPDDR6 IP, PHY, SMMU, or NoC.
- It does not claim that 14A SRAM density targets are met; the source data
  used 2 nm published macros and public 14A planning briefs as upper-bound
  references.
- It does not claim that the Ramulator/DRAMsim simulators are bit-accurate
  for the target LPDDR6 product; they are reference cycle-level models.

Every implementation step above replaces an existing fail-closed scaffold
gate with executable evidence. No gate is removed; gates are satisfied or
remain blockers.
