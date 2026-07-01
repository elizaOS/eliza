# Bandwidth, compression, and QoS for the E1 memory subsystem

Date: 2026-05-19

This document covers three coupled topics:

1. How to turn raw DRAM bandwidth into effective AI/display/camera bandwidth via
   on-die compression.
2. How to schedule DRAM traffic across CPU, NPU, GPU, display, camera ISP,
   modem, and audio DSP so the contract's QoS guarantees can hold.
3. Which DRAM simulators and scheduling algorithms can be used to model and
   verify the policy before silicon.

## Compression on the memory path

### Framebuffer / display compression

Lossless framebuffer compression is mandatory at mobile bandwidths. The
standards used in production:

| Standard | Vendor | Type | Where applied |
| --- | --- | --- | --- |
| AFBC (Arm Frame Buffer Compression) | Arm | Lossless | GPU and display, end-to-end |
| AFBE (Arm Frame Buffer Compression Extended) | Arm | Lossless | Extended block formats |
| DCC (Delta Color Compression) | AMD | Lossless | GPU color attachments |
| FBC (Lossless Frame Buffer Compression) | NVIDIA | Lossless | Color and Z |
| MFBC | Imagination | Lossless | Mobile GPU |

These compress display surfaces by ~30-50% on real-world content. Critically,
the producer (GPU) and consumer (display controller) must both understand
the compressed format; the buffer is never decompressed in DRAM. dma-buf
metadata carries the compression modifier (e.g., DRM_FORMAT_MOD_ARM_AFBC).

For E1: the display controller and the GPU must use AFBC (or successor) so
that scanout-time bandwidth is the compressed footprint, not the uncompressed
RGBA8 footprint. Without this, a 4K 120 Hz display alone consumes
`3840 * 2160 * 4 * 120 = 3.98 GB/s` per layer, which compounds with 3-5
composition layers and HDR formats.

### Texture compression

| Standard | Type | Notes |
| --- | --- | --- |
| ASTC | Lossy, variable bitrate (1-8 bpp) | Khronos, mobile standard |
| ETC1/ETC2 | Lossy fixed bitrate | Khronos, legacy |
| BCn (DXTC) | Lossy fixed bitrate | Desktop, used in cross-platform games |

ASTC is the 2028 mobile baseline. Compressed textures cut texture-fetch
bandwidth by 2-4x. For E1 this affects GPU bandwidth on shared DRAM, but does
not directly affect NPU traffic.

### Feature-map (activation) compression for NPUs

DNN activations are compressible because of (a) high zero density after ReLU,
and (b) bit-precision waste (FP32 storage for INT8-magnitude values). Public
techniques:

- **Zero-run-length / bitmap compression**: encode zero positions with a
  bitmap, store only non-zero values. 1.5-3x compression on ReLU-heavy
  feature maps (Eyeriss-v2, NVIDIA Sparse Tensor Cores).
- **Lossless quantization-aware compression**: encode quantized activations
  with smaller integers (INT4, INT2) for layers where quantization is
  validated.
- **Lossy feature-map compression**: e.g., AMC, FeatherCNN. Trade accuracy for
  bandwidth.

For E1: the DMA must understand a compressed feature-map format so that the
data going to/from DRAM is compressed; the local scratchpad holds expanded
data only for the active tile. This is the meaning of
`microarchitecture_targets.memory_system.compression_aware_dma`.

Recommend a single canonical on-chip compression format with the following
properties:

- 64-element block, header word + payload words.
- Bitmap-style zero compression for INT8 / INT4 / INT2 activations.
- Optional outlier escape (per-block) for INT2 with sparse outliers.
- Decode at the DMA engine on read; encode at the DMA engine on write.

### KV-cache compression

Decode-phase LLM inference is dominated by KV-cache reads. KV-cache
compression is a 2024-2026 research line; the publicly mature techniques:

- **FP8 KV cache** (e.g., NVIDIA TensorRT-LLM, vLLM): drop from FP16 to FP8,
  2x bandwidth savings, minor accuracy loss for most models.
- **INT4 KV cache with per-token scale**: 4x bandwidth savings, modest
  accuracy loss; requires per-token or per-head quantization.
- **KV cache eviction / streaming attention**: not compression but related;
  evicts old KV entries.
- **GQA / MLA**: architectural reduction of KV size, not strictly compression
  but the most powerful bandwidth-saving lever.

For E1: hardware should support FP8 and INT4 KV-cache loads with bandwidth
counters that report the compression ratio observed at runtime. The NPU
streaming attention path (in `microarchitecture_targets.dataflow`) should
operate on compressed KV directly.

### Compressed-DRAM and on-die compression

Beyond the producer/consumer formats above, there is a separate line of work
on transparent on-die compression in the memory controller (e.g., NVIDIA's
DCC, IBM Active Memory Expansion). These compress data inside DRAM rows so the
controller sees apparent capacity larger than physical capacity. Mobile APs
generally do not deploy this; the dominant pattern remains
producer/consumer-aware compression with the controller agnostic.

## QoS classes for the mobile AP

The contract requires QoS for camera, display, audio, modem, NPU, plus
implicit CPU and GPU. The traffic shape and constraint per class:

| Class | Hard real-time? | Bandwidth shape | Latency tolerance | Failure mode |
| --- | --- | --- | --- | --- |
| Display | Yes (scanout deadline) | Sustained, periodic | Bounded p99 | Underflow (visible tearing/black line) |
| Camera ISP | Yes (sensor pixel clock) | Sustained, periodic | Bounded p99 | Frame drop or buffer overflow |
| Modem | Yes (RF deadline) | Bursty + sustained DL | Bounded p99 | Link error, retransmit |
| Audio DSP | Yes (audio buffer deadline) | Low sustained | Bounded p99 | Audio glitch |
| CPU | Soft (UI responsiveness) | Bursty | p95 matters | UI jank |
| NPU | Soft (inference latency) | Sustained burst | p95 matters | Slower inference |
| GPU | Mixed | Bursty | p95 matters | Frame stutter |

Hard real-time traffic must never be starved. The recommended QoS pattern is
classic in mobile AP design and is documented in Arteris FlexNoC and Arm CMN
materials:

- **Priority classes**: at least 4 priority levels: Isochronous (display,
  camera, modem, audio), High (CPU latency-sensitive), Normal (NPU sustained,
  GPU), Best-effort (NPU prefetch, DMA copies).
- **Bandwidth caps**: each non-isochronous class has a maximum sustained
  bandwidth that cannot exceed (bw_target - isochronous reservation).
- **Bandwidth reservations**: each isochronous class has a minimum
  guaranteed bandwidth from each DRAM channel.
- **Latency targets**: per-class p99 round-trip latency targets at the DRAM
  controller; failing the target triggers a counter increment and (if
  configured) raises the class's priority.

For E1 the recommendation is:

| Class | Reserved bw | Cap | Latency target (p99) |
| --- | ---: | ---: | ---: |
| Display | 25% | n/a | <300 ns |
| Camera ISP | 15% | n/a | <300 ns |
| Modem DL | 5% | n/a | <500 ns |
| Audio DSP | 1% | n/a | <500 ns |
| CPU | 10% | 40% | <500 ns |
| NPU | 20% | 60% | <2 us |
| GPU | 15% | 50% | <2 us |
| Best-effort | 0% | residual | n/a |

(Reserved bw is a minimum on contended workloads; caps are maxima on
non-contended workloads. The numbers are example design points, not contract
gates.)

These numbers feed into the DRAM scheduler. The classical research on this
problem:

- **FR-FCFS** (First-Ready, First-Come-First-Served): default DRAM scheduler.
  Maximizes throughput, not fair.
- **PARBS** (Parallelism-Aware Batch Scheduling): batches requests from
  applications to preserve bank-level parallelism. ISCA 2008.
- **ATLAS**: latency-aware scheduler, ranks threads by attained service.
  HPCA 2010.
- **BLISS** (Blacklisting Memory Scheduler): low-cost fairness, blacklists
  noisy threads. ICCD 2014.
- **TCM** (Thread Cluster Memory): clusters threads into latency-sensitive
  and bandwidth-sensitive groups, applies different policies.

For E1: the controller should implement a hybrid that uses FR-FCFS as the
base, with PARBS-style batching to preserve bank parallelism and a TCM-style
clustering of isochronous vs CPU vs accelerator traffic.

## DRAM bandwidth modeling tools

To validate the QoS policy before silicon, use simulator-level evidence:

- **Ramulator 2** (CMU SAFARI): supports DDR5, LPDDR5, LPDDR5X, HBM3,
  GDDR6, with controller and scheduler plugin model. Recommended primary
  simulator for E1.
- **DRAMsim3** (Univ. of Maryland): cycle-accurate DDR/LPDDR/HBM, integrates
  with gem5. Secondary simulator for cross-checking Ramulator.
- **USIMM**: scheduler research testbed for PARBS/ATLAS/BLISS comparisons.
- **gem5**: full-system memory hierarchy with Ramulator/DRAMsim back-ends and
  Ruby coherence. Use for full-system traces.
- **ChampSim**: trace-driven cache + prefetcher simulator; pair with
  Ramulator for the DRAM tail.

Recommended verification flow:

1. Generate per-master traces from the cycle-accurate NPU model
   (`docs/spec-db/npu-2028-target.yaml` workload targets).
2. Mix traces according to a phone-class scenario (display 120 Hz scanout +
   camera 4K30 + NPU LLM decode + CPU UI + GPU UI compositor + audio + modem).
3. Replay through Ramulator 2 with LPDDR6 timing parameters and the proposed
   QoS scheduler.
4. Verify per-class latency p99 and sustained bandwidth.
5. Fail closed if any isochronous class misses its deadline.

Outputs from this flow become the evidence behind the `external_memory_bandwidth_gbps_min`
gate and the "shared system cache" claim.

## DMA design with compression awareness

The E1 DMA contract (`docs/arch/memory-map.md` DMA registers) is a 32-bit
single-beat scaffold today. The 2028 contract DMA must:

- Issue AXI4 / TileLink bursts (e.g., 64-byte cache line bursts at minimum).
- Support per-channel compression mode (none, INT8 zero-bitmap, INT4
  zero-bitmap, FP8 with scale, INT4 KV with per-token scale).
- Track compressed-byte and uncompressed-byte counters separately.
- Translate IOVAs through SMMU/IOMMU before DRAM access.
- Generate completion via cache stash to the CPU's L2 or to a kernel-visible
  doorbell.
- Honor QoS class assigned per descriptor.

Each compression mode is decoded/encoded at the DMA boundary. Once data
arrives at the tile-local SRAM, it is in the format the systolic engine
expects. No mid-pipeline decompression. This matches the Buffets pattern of
explicit decoupled access/execute: the DMA agent is the boundary between
DRAM-format and compute-format storage.

## What evidence the contract needs

The `docs/arch/memory-subsystem.md` evidence gate fails closed today. For the
2028 contract:

- Ramulator 2 / DRAMsim3 simulation report at LPDDR6 timings, with per-class
  QoS measurements.
- Synthesized DMA RTL with compression-aware decode/encode pipelines and
  cocotb tests for each compression mode.
- Cocotb-level proof that an unauthorized DMA stream is faulted by SMMU/IOMMU
  before reaching DRAM.
- Bench-level proof on the prototype board with measured DRAM bandwidth and
  measured per-class latency under contended workloads.

All four are blockers for the `external_memory_bandwidth_gbps_min` claim.
