# Competitor Snapshot and 2028 Target Envelope

Date: 2026-05-17

Purpose: compare the current Eliza RAM/CPU/NPU scaffold against public
Snapdragon/Apple/MediaTek/Google-class mobile SoCs, then set a 2028 target
envelope for an open RISC-V AI phone SoC. This is a planning artifact, not an
implementation claim.

## Source Rules

- Prefer vendor pages for architecture, memory type, and accelerator feature
  claims.
- Treat third-party benchmark tables and RAM/bandwidth figures as context, not
  proof for design signoff.
- Do not compare TOPS without precision, sparsity, clocks, power, thermal
  state, memory bandwidth, and CPU fallback.
- Mark any forward-looking 2028 number as an Eliza target assumption, not
  as an observed competitor number.

## Workstream Breakdown

| Workstream | Owned question | Artifact role |
| --- | --- | --- |
| RAM / memory | What memory capacity, bandwidth, cache, coherency, and IOMMU envelope is needed for an AI phone AP? | Convert public LPDDR5X-class signals into a 2028 target and list evidence needed before any bandwidth/capacity claim. |
| CPU | What open RISC-V AP class is needed to be phone-credible versus 2025-2026 flagship Arm/custom cores? | Compare current tiny CPU scaffold to flagship CPU topology and define the minimum Linux-capable RV64GC target. |
| NPU | What accelerator class is needed for on-device LLM/multimodal workloads? | Compare current MMIO NPU prototype to public low-precision/NPU software signals and define a target envelope. |
| Evidence / claims | What must stay blocked until silicon/software proof exists? | Separate sourced competitor observations, Eliza assumptions, and current repo non-claims. |

## Sourced Assumptions

| Assumption | Source basis | Confidence | How it is used |
| --- | --- | --- | --- |
| 2025-2026 Android flagship CPU class is 8-core big/performance-heavy, with Qualcomm using 2 Prime + 6 Performance Oryon cores and MediaTek using 1 C1-Ultra + 3 C1-Premium + 4 C1-Pro. | Qualcomm product brief and MediaTek product page. | High for topology and clocks published by vendors. | Sets the minimum bar for a credible 2028 RISC-V AP target: multiple Linux-capable application cores, not the current tiny CPU scaffold. |
| Current flagship mobile RAM is LPDDR5X-class, with Qualcomm publishing LPDDR5x up to 5300 MHz and up to 24 GB density, MediaTek publishing LPDDR5X 10667, Google Pixel 10-class coverage reporting LPDDR5X, and third-party Apple A19 Pro coverage reporting LPDDR5X. | Qualcomm, MediaTek, Android Central, Notebookcheck. | High for vendor memory type, medium for third-party capacity/bandwidth details. | Justifies 16 GB minimum, 24 GB stretch, and 120-180 GB/s planning envelope for 2028. |
| Public mobile AI direction is low precision, accelerator concurrency, memory locality, and framework integration rather than TOPS alone. | Qualcomm Hexagon NPU precision/features, MediaTek NPU 990/CIM claims, Apple Neural Engine/GPU Neural Accelerators, Google TPU/Gemini Nano context. | High for named vendor features; medium for performance uplift claims without full power/thermal data. | Drives INT8/INT4/INT2/FP8 targets, local SRAM, command queues, compiler/runtime evidence, and CPU fallback gates. |
| Synthetic benchmarks are not enough for design signoff. | Android Central Tensor G5 benchmark discussion and source-rules policy. | High as an evidence policy, not a numeric claim. | Requires power, thermal, model hash, unsupported-op, and fallback evidence before any performance claim. |

## Competitor Public Data Table

| SoC class | Public CPU signal | Public RAM / memory signal | Public NPU / AI signal | Planning implication |
| --- | --- | --- | --- | --- |
| Qualcomm Snapdragon 8 Elite Gen 5 | Qualcomm lists 2 Prime Oryon cores up to 4.74 GHz and 6 performance cores up to 3.62 GHz. | Qualcomm lists LPDDR5x up to 5300 MHz and up to 24 GB density; Notebookcheck reports 84.8 GB/s derived from the 64-bit LPDDR5X-5300 controller. | Qualcomm lists Hexagon NPU, fused AI accelerator architecture, scalar/vector/accelerator configuration, INT2/INT4/INT8/INT16/FP8/FP16 support, and 37% faster NPU versus prior generation. | A 2028 target must include low-precision AI, CPU-side matrix help, concurrency, memory virtualization, and at least 24 GB-class memory planning. |
| Apple A19 Pro | Apple lists 6 CPU cores: 2 performance and 4 efficiency. | Apple does not list RAM on its tech-spec page; Notebookcheck reports 12 GB LPDDR5X-9600 and about 75.8 GB/s. | Apple lists a 16-core Neural Engine and GPU Neural Accelerators. | CPU single-thread strength and GPU/NPU cooperation matter; public RAM figures may require secondary sourcing. |
| MediaTek Dimensity 9500 | MediaTek lists 1 Arm C1-Ultra, 3 C1-Premium, 4 C1-Pro, plus 16 MB L3 and 10 MB SLC. | MediaTek lists LPDDR5X 10667 and UFS 4.1 four-lane storage. | MediaTek lists NPU 990, 56% reduced peak power use, over 2x faster token generation, 4K text-to-image, and CIM-based NPU. | Memory locality, large caches, token-generation power, and model-serving software are as important as peak math. |
| Google Tensor G5 / Pixel 10 class | Android Central reports 1 Cortex-X4, 5 Cortex-A725, and 2 Cortex-A520, with Tensor G5 on TSMC 3 nm. | Android Central reports LPDDR5X, 12 GB RAM on Pixel 10, and 16 GB RAM on Pixel 10 Pro. | Android Central reports a 4th-generation TPU, up to 60% more TPU power than Tensor G4, and Gemini Nano improvements; it also notes Tensor G5 is not a benchmark leader. | Strong Android AI integration can be valuable even below raw flagship CPU/GPU performance. |

Source confidence:

- High: vendor-published CPU topology, memory type, and named NPU features.
- Medium: third-party RAM capacity and bandwidth figures where the vendor page
  does not publish them.
- Low for design budgeting: synthetic benchmark scores unless the test device,
  thermal state, power, and software version are archived.

## 2028 Spec Table

This envelope is intentionally below closed flagship ambition in modem/GPU/ISP
integration, but high enough to be credible for an open RISC-V AI phone AP if
backed by real silicon and software evidence.

| Area | 2028 target envelope | Evidence required before claim |
| --- | --- | --- |
| CPU | 4-8 Linux-capable RV64GC application cores, preferably OoO for big cores; at least one management/security RISC-V core; vector or matrix extension strategy documented. | OpenSBI log, Linux boot log, ISA string, privilege/MMU tests, interrupt/timer evidence, sustained CPU benchmarks with power and thermal traces. |
| Memory / RAM | 16 GB minimum product target, 24 GB stretch; LPDDR5X/LPDDR6-class external memory; at least 120 GB/s sustained usable bandwidth target and 180 GB/s stretch for AI-heavy SKU; 16-32 MB shared system cache. | DRAM controller/PHY evidence, training logs, board routing, memory test, STREAM/lmbench/fio, display+NPU contention tests, IOMMU/coherency validation. |
| NPU | Dense INT8 sustained 80 TOPS minimum; dense INT8 peak 160 TOPS target; INT4/INT2 and FP8 support; at least 64 MiB local SRAM; command queues, DMA, IOMMU isolation, per-context faults, and thermal counters. | MLPerf Mobile or equivalent, TFLite/ExecuTorch/IREE path, unsupported-op report, CPU fallback under 1%, power/thermal traces, model hashes, Android HAL/VTS evidence. |
| Phone AI experience | 3B INT4 LLM at 100 tok/s sustained target; 7B INT4 at 30 tok/s stretch; multimodal encoder under 30 ms; concurrent camera AI/display/audio QoS. | End-to-end app traces, token latency histograms, camera/display concurrent tests, scheduler/QoS counters, battery and skin-temperature logs. |

## Gap Table

| Area | Current Eliza state | 2028 target gap | Blocked claim |
| --- | --- | --- | --- |
| CPU | Tiny executable RISC-V subset over a 32-bit AXI-Lite manager. It fetches, runs a small integer subset, and halts fail-closed. Not Linux-capable. | Missing RV64GC application cores, privilege/CSR/trap model, MMU, caches, atomics, timer/software interrupts, coherent memory, OpenSBI/Linux boot evidence. | No flagship CPU, Android AP, or Linux-capable CPU performance claim. |
| RAM / memory | SRAM-backed DRAM aperture for tests. Docs reserve `0x8000_0000`; current model is not real DRAM capacity, timing, LPDDR PHY, training, refresh, or bandwidth evidence. | Missing LPDDR-class controller/PHY, 16-24 GB capacity plan, 100+ GB/s bandwidth, cache hierarchy, UMA/coherency, IOMMU, QoS, bandwidth counters, thermal/power evidence. | No LPDDR, RAM capacity, memory bandwidth, UMA, or AI/display contention claim. |
| NPU | MMIO datapath with scalar ops, DOT4_S8, DOT8_S4, bounded 64-byte scratchpad GEMM_S8, interrupt, and counters. | Missing tensor command queues, DMA-fed scratchpad, large SRAM, systolic/vector tiles, INT2/FP8, compiler backend, Android delegate/HAL proof, power/area model, sustained benchmarks. | No mobile tensor NPU, TOPS, Android accelerator, or sustained AI workload claim. |

Target assumptions:

- 2028 mobile AI will be constrained by memory locality, thermal envelope, and
  software coverage more often than by raw peak math.
- An open RISC-V phone SoC does not need to match closed modem/GPU/ISP stacks
  to be useful, but it does need credible Linux/Android boot, memory, and NPU
  evidence.
- 24 GB RAM is a stretch target because Qualcomm publicly supports up to 24 GB
  density in the Snapdragon 8 Elite Gen 5 class, while Tensor/Apple public
  device context is lower.
- The 120 GB/s sustained and 180 GB/s stretch memory-bandwidth targets are
  Eliza planning assumptions derived from public LPDDR5X-class bandwidths
  and AI/display concurrency needs; they are not observed e1-chip results.
- The NPU envelope is aligned with `docs/spec-db/npu-2028-target.yaml`, but
  this artifact keeps CPU and memory targets in the same comparison frame.

## Source Links

- Qualcomm product brief: Snapdragon 8 Elite Gen 5 CPU clocks, Hexagon NPU
  feature set, low-precision support, LPDDR5x up to 5300 MHz, and up to 24 GB
  memory density.
  Source: [Qualcomm Snapdragon 8 Elite Gen 5 product brief](https://www.qualcomm.com/content/dam/qcomm-martech/dm-assets/documents/Snapdragon-8-Elite-Gen-5-product-brief.pdf)
- MediaTek product page: Dimensity 9500 CPU cluster, LPDDR5X 10667, UFS 4.1,
  NPU 990, power/token-generation claims, and CIM-based NPU.
  Source: [MediaTek Dimensity 9500](https://www.mediatek.com/products/smartphones/mediatek-dimensity-9500)
- Apple support page: A19 Pro 6-core CPU, 6-core GPU with Neural Accelerators,
  and 16-core Neural Engine.
  Source: [Apple iPhone 17 Pro tech specs](https://support.apple.com/en-us/125090)
- Android Central Tensor G5 coverage: Tensor G5 CPU topology, LPDDR5X, Pixel 10
  and Pixel 10 Pro RAM context, TPU improvement claims, and benchmark caveats.
  Source: [Google Tensor G5 coverage](https://www.androidcentral.com/phones/google-pixel/google-tensor-g5)
- Notebookcheck context only: Snapdragon 8 Elite Gen 5 memory bandwidth and
  Apple A19 Pro RAM/bandwidth figures where vendor pages do not publish the
  exact number.
  Sources: [Snapdragon 8 Elite Gen 5 Notebookcheck](https://www.notebookcheck.net/Qualcomm-Snapdragon-8-Elite-Gen-5-Processor-Benchmarks-and-Specs.1123169.0.html), [Apple A19 Pro Notebookcheck](https://www.notebookcheck.net/Apple-A19-Pro-Processor-Benchmarks-and-Specs.1126974.0.html)

## Claim Boundaries

- The current repo does not implement a flagship CPU, DRAM subsystem, or mobile
  NPU.
- QEMU/Renode, AXI-Lite SRAM, and MMIO NPU tests are scaffold evidence only.
- The 2028 envelope is a target for architecture planning and evidence gates,
  not proof that the design meets those numbers.
- Public competitor figures are not copied as implementation requirements; they
  are context for an open RISC-V target envelope.
- Any future claim must cite the exact artifact, command, device, clock, power,
  thermal state, software build, and source revision used to produce it.

## Open Blockers

- CPU: integrate or generate a Linux-capable RV64GC AP, then prove OpenSBI and
  Linux boot on the target memory map.
- RAM: replace SRAM-backed DRAM models with a real external memory
  controller/PHY plan, board routing, training logs, and bandwidth evidence.
- NPU: replace MMIO scalar/scratchpad prototype with a tensor accelerator,
  compiler/runtime path, Android HAL evidence, and sustained power/thermal
  benchmarks.
- Product: keep modem, WiFi, ISP, GPU, PMIC, certification, and Android
  compatibility claims out of scope until each has its own evidence gate.
