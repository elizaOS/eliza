# AI Accelerator SOTA Synthesis

Date: 2026-05-19

## Executive Findings

The leading AI accelerator pattern is no longer a single larger matrix array.
Blackwell, Ironwood, TPU v4, and current mobile NPUs point to a system design:
lower precision, much larger local or package memory, high-bandwidth collective
communication, explicit transformer datapaths, power-aware scheduling, and
compiler/runtime co-design.

For E1, the highest-return work is to turn the current bounded MMIO NPU smoke
path into a parameterized DMA-fed tensor tile with a real local memory hierarchy,
structured sparsity, transformer-specific fused operations, and a cycle/energy
model. A 14A/sub-2 nm target changes the implementation priorities: IR drop,
self-heating, aging, SRAM Vmin, package bandwidth, and yield-aware chiplets
become first-class design inputs rather than late physical-design details.

## TPU Lessons

### TPU v4

Source: `https://arxiv.org/abs/2304.01433`

TPU v4 shows that production ML throughput depends on cluster architecture as
much as per-chip TOPS. The key ideas are:

- Reconfigurable optical circuit switches for topology, availability, and
  utilization.
- Explicit SparseCore hardware for embeddings, with reported 5x-7x embedding
  speedups at about 5% die area and power.
- 2.1x per-chip performance over TPU v3 and 2.7x performance/W improvement.
- Pod-level scaling to 4096 chips, using interconnect topology as a product
  feature.

E1 implication: add an embedding/sparse gather/scatter requirement now, even if
the first RTL is only a small SRAM-backed sparse/load coalescer. LLM and recommender
models are memory dominated, and a dense GEMM-only accelerator misses this class.

### Compute-in-Memory TPU

Source: `https://arxiv.org/abs/2503.00461`

The DATE 2025 CIM-TPU paper argues that replacing conventional MXU blocks with
digital compute-in-memory can reduce MXU energy dramatically and improve
generative-model inference. The reported headline is up to 44.2% LLM inference
performance improvement, 33.8% diffusion-transformer improvement, and 27.3x MXU
energy reduction versus a TPUv4i-style baseline under explored design choices.

E1 implication: do not claim CIM without a memory macro and process library, but
do add a research-backed local-memory energy model that can compare:

- conventional SRAM + systolic MAC,
- near-memory SRAM banking with row-local dot products,
- bit-serial or bit-sliced INT4/INT2 array modes,
- future CIM macro placeholder with explicit `BLOCKED` gates.

### Edge TPU

Source: `https://arxiv.org/abs/2108.13732`

Edge TPU practice reinforces that real deployment is constrained by compiler
coverage, quantization rules, supported ops, memory transfer, and thermal limits.

E1 implication: every new accelerator op needs a compiler/runtime smoke path and
rejection tests. Unsupported ops should fail before MMIO or DMA side effects.

### TPU-Gen

Source: `https://arxiv.org/pdf/2503.05951`

TPU-Gen is relevant because it treats TPU architecture as generator output
rather than hand-authored one-off RTL. That matches the direction E1 needs:
parameterized array dimensions, scratchpad sizes, precision modes, banking,
NoC/DMA, and energy counters.

E1 implication: replace hard-coded NPU dimensions with a checked generator
configuration file and emit both RTL parameters and software capability metadata
from one source.

### Google Ironwood / TPU v7

Source: `https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/ironwood-tpu-age-of-inference/`

Ironwood is publicly positioned as an inference-era TPU. Public claims include
192 GB HBM per chip, 7.37 TB/s HBM bandwidth per chip, 1.2 TB/s bidirectional
inter-chip interconnect, 2x perf/W relative to Trillium, and nearly 30x power
efficiency relative to the first Cloud TPU.

E1 implication: future SOTA is memory-capacity and memory-bandwidth weighted.
Targets should include bytes/FLOP, HBM/LPDDR bandwidth per TOPS, KV-cache
bandwidth, and sustained tokens/J, not only peak TOPS.

## GPU Lessons

### NVIDIA Blackwell

Sources:

- `https://www.nvidia.com/en-us/data-center/technologies/blackwell-architecture/`
- `https://www.nvidia.com/en-gb/data-center/gb200-nvl72/`
- `https://www.nvidia.com/en-gb/data-center/gb300-nvl72/`
- `https://developer.nvidia.com/blog/nvidia-blackwell-ultra-for-the-era-of-ai-reasoning/`

Blackwell's public differentiators are:

- Dual reticle-limited GPU dies with a 10 TB/s die-to-die interconnect.
- Second-generation Transformer Engine with FP4 and fine-grain scaling.
- NVLink/NVSwitch fabric with 130 TB/s in one 72-GPU NVLink domain.
- 72-GPU rack-scale coherent domain in GB200 NVL72.
- Very high HBM capacity and bandwidth: 13.4 TB HBM3E and 576 TB/s per rack in
  the GB200 NVL72 public table.
- Dedicated decompression and RAS engines.
- Confidential-computing support with protected host/device I/O.
- Blackwell Ultra / GB300 shifts the public SOTA comparison point toward
  reasoning and long-context inference, with NVIDIA claiming 1.5x more AI
  compute FLOPS than Blackwell GPUs and up to 288 GB HBM3E per GPU.

E1 implication: Blackwell's relevant lessons for a phone-class or small SoC are
not rack scale itself, but:

- FP4/FP6/FP8 style microscaling support for transformer inference.
- Attention and MoE data movement as first-class workload paths.
- Dedicated command processors, decompression, and reliability telemetry.
- A software stack that exposes placement, scheduling, and precision control.

## Mobile SoC Lessons

### Qualcomm Snapdragon 8 Elite Gen 5

Sources:

- `https://www.qualcomm.com/news/releases/2025/09/snapdragon-8-elite-gen-5--the-world-s-fastest-mobile-system-on-a`
- `01_sources/downloads/qualcomm_snapdragon_8_elite_gen5_product_brief.pdf`

Public claims include a 37% faster Hexagon NPU versus prior Snapdragon 8 Elite,
20% CPU uplift, 23% GPU uplift, Adreno High Performance Memory, tile-memory
features, LPDDR5X support up to 5300 MHz, UFS 4.1, and 3 nm process technology.

E1 implication: mobile AI performance is a heterogeneous platform feature. NPU,
GPU, ISP, memory controller, display, camera, secure enclave, and OS delegate
all contribute to perceived AI capability. E1 should add shared memory and
delegate contracts early rather than treat the NPU as an isolated block.

### MediaTek Dimensity 9400

Sources:

- `https://www.mediatek.com/press-room/mediateks-dimensity-9400-flagship-soc-offers-extreme-performance-and-efficiency-for-the-latest-ai-experiences`
- `https://www.mediatek.com/products/smartphones/mediatek-dimensity-9400`

Public claims include second-generation TSMC 3 nm, up to 40% SoC power
efficiency improvement over Dimensity 9300, 8th-generation NPU, up to 80% faster
LLM prompt performance, up to 35% better AI power efficiency, LPDDR5X 10667
support, Immortalis-G925 GPU, and explicit on-device LoRA, video generation,
DiT, and MoE positioning.

E1 implication: a SOTA mobile target needs NPU operations for dynamic sequence
models, not only fixed CNN-style inference. Plan for KV-cache, LoRA adapters,
small-rank updates, MoE routing, and diffusion/DiT blocks.

## Cross-Cutting Architecture Themes

1. Lower precision is mandatory.
   INT8 is baseline. INT4 is now mainstream for inference. FP8 is mainstream
   for training/inference. FP4/NVFP4-style microscaling is a SOTA feature for
   next-generation inference and training.

2. Memory traffic dominates.
   On-chip SRAM, HBM/LPDDR bandwidth, KV-cache locality, bank conflicts, and
   sparse gathers matter more than raw MAC count for many LLM workloads.

3. Transformer blocks are hardware targets.
   SOTA accelerators expose paths for matmul, attention, MLP, normalization,
   activation, reduction, transpose, cache update, and precision scaling.

4. Sparsity needs structure.
   Useful near-term targets are 2:4 or block sparsity, embedding tables,
   compressed weights, and MoE expert routing. Unstructured sparsity needs
   metadata bandwidth and scheduling work before it pays off.

5. Compiler/runtime coverage is a product feature.
   Edge TPU and mobile NPUs show that unsupported compiler paths erase hardware
   value. Every hardware optimization needs a lowering, simulator, Linux/Android
   interface, and negative tests.

6. Power delivery and thermals are architectural.
   Blackwell uses liquid-cooled rack integration; mobile SoCs use tight DVFS and
   memory hierarchy control; 14A/sub-2 nm nodes need backside power and
   reliability-aware timing. E1 must model sustained performance, not just burst
   peak.

7. Packaging is part of the accelerator.
   2.5D/3D integration, HBM stacks, UCIe/EMIB-style die-to-die links, and
   chiplet yield strategy determine feasible memory bandwidth and die size.

## Recommended E1 Direction

E1 should converge on a heterogeneous mobile AI architecture:

- RISC-V AP/host with a descriptor-driven NPU command processor.
- Parameterized systolic/tensor array with INT8, INT4, sparse INT4, FP8, and
  future FP4 microscaling hooks.
- Banked local SRAM scratchpad sized by tile model, not hard-coded smoke limits.
- DMA engine, descriptor ring, and cache-coherent or explicitly synchronized
  shared-memory path.
- Transformer fused-op pipeline: QK, softmax approximation, AV, MLP, GELU/SiLU,
  layer/RMS norm, residual/bias, KV-cache update, rotary embedding.
- Sparse/embedding side unit for gather, scatter, compressed weights, 2:4
  metadata decode, and MoE routing.
- Cycle and energy model tied to RTL parameters and process assumptions.
- Linux/Android UAPI and NNAPI/IREE/XLA/TFLite lowering evidence gates.
