# Coherency, on-chip fabric, and NoC options for E1

Date: 2026-05-19

This document maps coherence protocols, on-chip fabric options, and accelerator
integration patterns onto the E1 2028 contract. The relevant contract entries
are:

- `microarchitecture_targets.memory_system.cache_coherent_cpu_submission`
- `microarchitecture_targets.memory_system.iommu_isolated_command_buffers`
- `docs/arch/interconnect.md`: current AXI-Lite scaffold, no IDs, no bursts,
  no coherence, fixed CPU-priority mux. Marked as fail-closed scaffold only.
- `docs/arch/memory-subsystem.md`: blockers including coherent DMA, IOMMU,
  QoS, and DRAM/LPDDR.

## Coherence protocols at a glance

| Protocol | States | Use case | Note |
| --- | --- | --- | --- |
| MESI | Modified, Exclusive, Shared, Invalid | Most x86/Arm CPU L1/L2 caches | minimal, widely understood |
| MOESI | + Owned | Allows dirty data to be shared without writeback to memory | AMD CPUs, BlackParrot |
| MESIF | + Forward | Avoids duplicate replies in directory designs | Intel multi-socket |
| Directory-based (e.g., MESI + directory) | n/a | Scales beyond snoopy bus, used in mesh fabrics | NoC-native |
| Token Coherence | n/a | Research / open NoC | Not common in production AI SoCs |

For a 2028 phone-class AP with CPU cluster + NPU + GPU + display + camera ISP +
modem + audio DSP, snoop-only is too expensive at the fabric width required.
The realistic options are:

- **Arm CHI-E or CHI-F**: directory-based coherent fabric used in Arm CMN-700,
  CMN-S3 and CMN-Cyprus class IP. Native to Cortex-X4/X5/X925 mobile clusters.
- **AMBA ACE / ACE-Lite**: bridge-style accelerator coherence. ACE-Lite is the
  "I/O coherent" path: accelerator participates in snoop-as-target without
  caching, used by GPUs and AI accelerators that do not hold modified state.
- **TileLink-C** (TL-C): the coherent TileLink variant used by Chipyard's
  InclusiveCache L2. Snoop-as-probe and broadcast or directory variants.
- **CXL.cache**: device-attached cache coherence over the CXL link. Out of
  scope for on-die mobile AP fabric, in scope as a lesson surface for
  accelerator coherence.

## What "cache-coherent CPU submission" requires

The contract entry means:

1. The CPU can place an NPU command descriptor (or a queue head pointer
   update) into a cacheable region, and the NPU can observe the update
   without an explicit cache maintenance operation.
2. The reverse: NPU completion notifications (e.g., descriptor done bits,
   error syndromes) become CPU-visible without explicit invalidate.
3. dma-buf-style buffers shared between CPU, NPU, display, and camera
   participants do not require manual cache flush/invalidate by the kernel
   driver under normal flows.

The realistic implementation patterns are:

| Pattern | Description | Cost |
| --- | --- | --- |
| Full coherent | NPU has a coherent L1/L2 and participates in CHI/TileLink-C | High area; complex verification |
| I/O coherent | NPU is snoop-as-target (ACE-Lite / TL-UH "Acquire" via cache stash); never holds modified state | Lower cost; standard mobile pattern |
| Coherent stash | CPU can "stash" data directly into NPU local SRAM via cache stash mechanism (CHI feature) | Low command-submission latency |
| Non-coherent + ABI | All sharing goes through cache maintenance ABI (clean/invalidate/fence) | Software-heavy; mistakes corrupt buffers |

For E1, the recommended pattern is I/O coherent NPU using ACE-Lite or
TileLink-C with cache stash for the command-queue head. The NPU does not hold
modified copies of system data; the SLC and CPU L2 are the coherent agents.

## Fabric IP options

### Arm CMN family (CHI-E/F)

Arm CMN-700 and successors are the standard mobile/edge coherent mesh fabric.
They support:

- CHI-E or CHI-F (Issue F adds DVMs, atomics, RME-DSC)
- SMMU integration for translation
- Cache stash, hardware coherent device, GIC bridging
- Up to 8x8 or larger mesh topologies; for a phone-class AP a 4x4 or 3x4
  mesh is typical

Licensing/closed-source. The realistic E1 path with CMN is to license CMN-S3
or successor, or to use a CHI-compliant alternative.

### TileLink-C + Chipyard InclusiveCache

Chipyard ships an InclusiveCache (SiFive open IP) implementing TileLink-C
coherence. Used as L2 in Rocket and BOOM SoCs. Strengths:

- Open RTL, fully testable
- Designed for RISC-V; integrates with Rocket/BOOM/CVA6
- Banked, configurable size
- Probe/release flow matches MOESI-style invalidate/forward

Limitations:

- Single-cluster oriented; multi-cluster scaling needs additional directory
  or broadcast fabric.
- No native cache stash; requires extension.
- No native ACE-Lite bridge; needs a TL-to-ACE/AXI4 bridge for IP that speaks
  AMBA.

For E1, TileLink-C is the natural choice if CPU is RISC-V. CHI is the natural
choice if CPU is Arm. A pragmatic 2028 mobile AP can carry a TileLink-native
CPU cluster + L2 with an AXI4/ACE bridge to the GPU and display IP.

### Arteris FlexNoC / Ncore (commercial)

Used widely in Snapdragon, Dimensity, Exynos. Closed-source. Strengths: mature
NoC + coherent fabric (Ncore) with QoS, virtual channels, and AMBA bridging.
For E1, FlexNoC is a fallback if open RTL cannot meet the area/timing budget
at 14A.

### Open RTL NoC generators

| Generator | Source | Note |
| --- | --- | --- |
| Constellation | UC Berkeley / Chipyard | Mesh/torus, VCs, in-tree |
| ProNoC | OpenCores | Configurable router |
| CONNECT | CMU | FPGA-focused |
| OpenSoC Fabric | LBNL | HPC-oriented |
| OpenNoC | Various | Not consolidated |

For E1 the recommended open-RTL NoC is Constellation, because:

- It lives inside Chipyard and integrates with TileLink-C.
- It supports parameterized mesh and virtual-channel allocation.
- It has been used in published silicon (Hwacha / BROOM / Esperanto papers
  cite Chipyard NoC).

## Topology for E1

A 2028 phone-class AP with 8-16 NPU tiles, 2-3 CPU clusters (perf + efficiency +
LITTLE), GPU, ISP, display, modem, audio DSP, and SLC has roughly 24-32 fabric
nodes. A 4x4 or 5x5 mesh NoC is the right size. The pattern:

```
+---+---+---+---+---+
| C | C | C | G | D |    C = CPU cluster, G = GPU slice, D = Display
+---+---+---+---+---+
| C | S | S | S | I |    S = SLC bank, I = ISP / camera
+---+---+---+---+---+
| N | N | N | N | M |    N = NPU tile, M = Modem / Audio DSP
+---+---+---+---+---+
| N | N | N | N | E |    E = external memory controller port
+---+---+---+---+---+
| N | N | N | N | E |
+---+---+---+---+---+
```

The SLC is co-located with the high-bandwidth consumers (CPU, GPU, NPU); the
external memory ports sit on the edge with multiple ports for QoS isolation.
NPU tiles cluster together because tile-to-tile traffic for split-K and
all-reduce-style operators dominates intra-NPU traffic.

## IOMMU / SMMU integration

The contract requires `iommu_isolated_command_buffers`. The relevant standards:

- **Arm SMMUv3**: per-stream isolation, stage-1 and stage-2 translation,
  page faults via interrupt + GICv3, hardware DVM (distributed virtual memory)
  for TLB shootdown.
- **RISC-V IOMMU** (ratified 2024-2025): per-device-id translation, faults via
  PLIC/IMSIC, two-stage translation.

For E1 specifically:

- Every DMA-capable master (NPU DMA, GPU, display, camera ISP, modem) must
  sit behind an SMMU/IOMMU domain.
- Per-context fault isolation means each NPU context has its own stream ID,
  with separate page tables.
- Command-buffer submission goes through IOVA, not physical address, so the
  CPU driver can hand DMA the descriptor ring without exposing physical
  memory.

## Cache stash for NPU

Cache stash (Arm CHI feature, also implementable as TileLink extension)
allows a producer to write directly into a target's cache. For E1:

- CPU writes NPU command descriptor; the write is stashed into the NPU's
  local SRAM (or into the SLC slice closest to the NPU).
- NPU reads its command queue from local SRAM at SRAM latency, not DRAM
  latency.
- Saves ~80-150 ns of submission latency per command.

This is a CHI-native feature (Stash hint), implementable in TileLink-C with
an extension primitive. Recommend supporting it in E1 as the canonical
mechanism for command submission.

## CXL relevance for an on-die mobile AP

CXL 1.1/2.0/3.x is a link-level protocol between socketed devices. It is not
on-die fabric. For E1, CXL is out of scope. The lesson surface:

- CXL.cache: pattern for a device-attached cache that participates in host
  coherence. Closest analog on-die is "I/O coherent accelerator with cache
  stash", which is what E1 should target.
- CXL.mem: pattern for an external memory expander. Not a phone-class
  feature.
- Memory pooling / shared memory regions: not applicable to a single-die AP.

Document CXL as a watched standard for future AI server SoCs, not as an
E1 phone-class deliverable.

## Coupled cache designs and last-level cache reorganization

Eyeriss-v2's cluster-level shared scratchpad and MAERI's tree-style
configurable interconnect both teach the same lesson: the NPU compute fabric
benefits more from tile-cluster-local memory than from a single large flat
buffer. The Buffets formalism (see `sram_and_local_memory.md`) gives the
storage primitive; the NoC must give the bandwidth.

For E1: design the per-tile-cluster scratchpad and NoC such that:

- Tile-to-tile bandwidth within a 2x2 cluster is at least 2x the
  cluster-to-SLC bandwidth.
- Cluster-to-SLC bandwidth is at least 2x the SLC-to-DRAM bandwidth.

This is the standard memory hierarchy bandwidth pyramid; the multipliers are
not novel but they need to be reflected in the NoC topology and bisection
bandwidth.

## Recommendation summary

- Coherent fabric: TileLink-C if CPU is RISC-V; CHI-E/F if CPU is Arm.
- NPU integration: I/O coherent via ACE-Lite or TL-UH with cache stash.
- IOMMU: SMMUv3 or RISC-V IOMMU, per-master stream IDs, fault path through PLIC
  or GICv3.
- NoC RTL: Chipyard Constellation as the open baseline; FlexNoC as the
  commercial fallback if open RTL cannot meet 14A timing.
- Topology: 4x4 or 5x5 mesh with SLC banks co-located with high-bandwidth
  consumers and edge-port DRAM controllers.
- CXL: out of scope for E1 silicon.
