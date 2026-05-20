# NPU Accelerator 2026 Research Packet

Date: 2026-05-19

This packet is the second pass of NPU / AI accelerator research for the Eliza
E1 chip. The earlier packet under
`packages/chip/research/ai_accelerator_sota/` is preserved as the TPU /
rack-scale / sub-2 nm reference. This packet extends scope to the **mobile NPU
microarchitecture and on-device LLM serving design space** that drives the
2028 phone-class NPU targets in
`docs/spec-db/npu-2028-target.yaml` and the phase gates in
`docs/spec-db/npu-2028-roadmap.yaml`.

## Scope

1. Mobile NPU microarchitecture: Hexagon NPU6, MediaTek NPU 990 + CIM, Apple
   Neural Engine + GPU Neural Accelerators, Samsung NPU, Edge TPU, ARM
   Ethos-U / Ethos-N, Tesla / Tenstorrent.
2. Tile-based / systolic / dataflow architectures: TPU v4..v7 Ironwood,
   Cerebras WSE-3, Groq TSP, Tenstorrent Wormhole/Blackhole, MTIA v2,
   Trainium2, NVIDIA Blackwell / FP4 Transformer Engine.
3. Open-source accelerator RTL / generators: Gemmini, NVDLA, VTA / TVM, ESP,
   Vortex, Snitch + RedMulE, PULP, MemPool, OpenGeMM.
4. Quantization and low-precision: GPTQ, AWQ, SmoothQuant, SpinQuant, QuaRot,
   HQQ, OmniQuant, BitNet b1.58 / a4.8, OCP MX formats (MXFP8/MXFP6/MXFP4/
   MXINT8), FP8 E4M3/E5M2.
5. Sparsity: SparseGPT, Wanda, 2:4 N:M, SpAtten, MaskLLM, sparse-dense engines.
6. Compute-in-memory / processing-in-memory: Samsung HBM-PIM, SK Hynix AiM,
   UPMEM, EnCharge, Mythic, SRAM digital CIM (TSMC 3 nm ISSCC 2024), ReRAM.
7. Attention / transformer accelerators: FlashAttention 1/2/3, FuseMax,
   SpAtten, A3, ELSA, Ring/Blockwise attention.
8. On-device LLM serving: vLLM PagedAttention, H2O, StreamingLLM, KIVI, GQA,
   MQA, MLA, Medusa, EAGLE/EAGLE-2.
9. Activation / normalization datapaths: GELU/SwiGLU, RMSNorm, LayerNorm,
   RoPE.
10. Speech / vision / multimodal accelerators: Whisper streaming, WhisperKit,
    Mamba / Mamba-2.
11. DMA / scratchpad / tensor scheduling: Eyeriss v1/v2, MAERI, SIGMA.
12. Power / area efficiency: vendor power claims, MX-format efficiency,
    near-threshold operation context.

## Files

- `01_sources/source_inventory.yaml` — provenance for >=60 distinct sources
  across the 12 scope areas.
- `02_analysis/mobile_npu_landscape.md` — 2024-2026 mobile NPU competitive
  analysis vs. E1 2028 targets.
- `02_analysis/open_accelerator_rtl.md` — usable open-source NPU/GPU/tensor
  RTL keyed to E1 integration paths.
- `02_analysis/quantization_int4_int2_fp8.md` — low-precision algorithm and
  hardware co-design evidence and recommended formats.
- `02_analysis/sparsity_and_attention.md` — N:M sparsity, attention
  accelerators, KV-cache management.
- `02_analysis/cim_and_near_memory.md` — CIM/PIM landscape and applicability
  to a phone NPU.
- `02_analysis/dataflow_and_scheduling.md` — dataflow taxonomies, tiling,
  compiler/runtime hardware seam.
- `03_implementation/npu_e1_recommendations.md` — ranked recommendations
  (High/Med/Low confidence) tied to E1 docs and phase gates.

## Claim boundary

This packet is **research only**. It cites public papers, vendor briefs, open
project pages, and standards. None of the sources prove E1 silicon, power, or
benchmark behavior. E1 phase gates remain governed by
`docs/spec-db/npu-2028-roadmap.yaml` and the evidence manifests under
`docs/benchmarks/capabilities/`. Vendor TOPS, perf/W, and process claims are
recorded as marketing or whitepaper data unless backed by an ISSCC, HotChips,
or peer-reviewed paper.

## How to use

- When proposing an E1 architectural change (RTL, ABI, compiler), cite the
  source IDs in `01_sources/source_inventory.yaml` and the analysis file that
  links them to a specific phase gate.
- When evaluating a vendor benchmark or claim, prefer the primary paper or
  vendor whitepaper from this inventory over secondary press articles.
- Do not modify upstream chip RTL or specs from this packet. Recommendations
  are routed through `03_implementation/npu_e1_recommendations.md` and must
  pass the existing `packages/chip` validation gates before any RTL or spec
  change is made.
