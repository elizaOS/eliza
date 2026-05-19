# Mobile NPU competitive landscape, 2024–2026

Date: 2026-05-19

This file is a source-backed competitive read of the mobile NPU space against
the Eliza E1 2028 targets in `docs/spec-db/npu-2028-target.yaml`. It is not a
silicon comparison and does not claim measured E1 silicon performance.

## Public 2025 mobile-AP baselines

| Vendor / Part | Year | NPU public claim | KV / on-device LLM features | Source |
| --- | --- | --- | --- | --- |
| Qualcomm Snapdragon 8 Elite Gen 5 (Hexagon NPU6) | 2025 | 12 scalar + 8 vector + 1 accelerator fused; native INT2 and FP8; "37% faster NPU", "16% better NPU perf/W" gen-over-gen; on-device 220 sustained tok/s claimed | INT2 + FP8 + mixed precision claimed as enabler for larger on-device LLMs | `qualcomm_snapdragon_8_elite_gen5_brief`, `qualcomm_snapdragon_8_elite_gen5_press` |
| MediaTek Dimensity 9500 (NPU 990 + "Super Efficient" CIM NPU) | 2025 | ~100 TOPS combined (NPU 990 + CIM NPU + SME2 CPU); "industry-first" mobile CIM NPU; Generative AI Engine 2.0; ~2x compute throughput vs 9400 | Native BitNet 1-bit processing, 128K context, on-device 4K image generation claimed | `mediatek_dimensity_9500_product`, `mediatek_dimensity_9500_press` |
| Samsung Exynos 2600 | 2025 | 113% higher generative-AI perf vs predecessor (vendor claim) | ExecuTorch deployment path | `samsung_exynos_2600_page` |
| Apple A19 Pro | 2025 | 16-core Neural Engine plus per-GPU-core "Neural Accelerators"; ~45 TOPS aggregate claim | 12 GB LPDDR5X at 9600 MT/s ≈ 76.8 GB/s memory bandwidth | `apple_a19_pro_overview`, `apple_a19_pro_notebookcheck` |
| Qualcomm Snapdragon X2 Elite (laptop) | 2025 | 80 TOPS class Hexagon | 152 GB/s LPDDR5X bandwidth | `qualcomm_x2_elite_semiaccurate` |

All numbers in this table are vendor or vendor-derived claims. They are
recorded as competitive context, not as proof of accelerator behavior.

## What the 2025 baselines tell us about the 2028 E1 target

The E1 numeric targets are anchored on this baseline and a 2x..3x scaling
window over two years. Key implications:

1. **Precision matrix is settled.** All 2025 flagship NPUs ship at least
   INT8 / INT4 / FP16 / FP8, and the leading two (Hexagon NPU6, NPU 990) ship
   INT2 / BitNet. The E1 precision list
   (`precision_requirements.required = int8, int4, int2, fp8, bf16, fp16,
   int32_accumulate`) matches the field; we cannot ship a 2028 phone NPU
   without it.

2. **Sparse INT4 ≥ 3x dense INT8 is already realistic.** Datacenter parts
   from Trainium2 (`trainium2_aws_docs`) ship 4x sparse FP8 over dense FP8.
   The E1 target ratio (160 dense INT8 -> 512 sparse INT4, ≈ 3.2x) is
   therefore conservative against the datacenter ratio and aligned with
   competitive direction. The choice is whether to bake sparsity into the
   tile or implement it as a sparsity-decode engine in front of the dense
   tile.

3. **CIM is no longer a research bet.** The MediaTek NPU 990 ships a
   compute-in-memory NPU alongside the digital NPU and uses it for
   always-on AI (`mediatek_dimensity_9500_product`). TSMC has a 3 nm 6T-SRAM
   digital CIM macro on the foundry shelf (`tsmc_dcim_isscc2024`). The E1
   has a credible path to either an optional digital SRAM CIM tile in 14A
   or to a CIM-IP partner block. Analog CIM (`encharge_ieee_spectrum`,
   `encharge_en100_dcd`) is a higher-risk option with higher claimed
   perf/W.

4. **The phone-class memory wall is real.** Even the A19 Pro tops out at
   ~76.8 GB/s LPDDR5X and the laptop X2 Elite at ~152 GB/s. The E1 target
   (`external_memory_bandwidth_gbps_min: 180`) requires LPDDR5X at
   12.8 GT/s or LPDDR6 at the bottom of the LPDDR6 range. This is
   accomplishable but only if the memory subsystem keeps pace; this becomes
   a system-level constraint, not a pure NPU constraint.

5. **Sustained perf, not peak, is the credible metric.** Every vendor claim
   in the table above is a peak number. The E1 sustained targets
   (`dense_int8_sustained_tops_min=80`, `sparse_int4_sustained_tops_min=200`,
   `sustained_perf_per_w_int8_tops_min=18`, `sustained_npu_power_w_max=4.5`)
   are roughly half the peak targets, which matches the typical phone burst-
   to-sustained ratio observed across the industry. Power and thermal traces
   in `software_targets.evidence` are the gate that makes those numbers
   defensible.

6. **Software is the moat.** Every flagship 2025 NPU has an explicit
   software backend: Hexagon QNN / AI Engine Direct, Apple Core ML + ANE,
   MediaTek NeuroPilot, Samsung's ExecuTorch backend. The E1
   `software_targets.compiler` list (MLIR + StableHLO + TFLite delegate +
   ExecuTorch/PyTorch + IREE/TVM) maps to the same surface area. The
   compiler stack must hit the same operator coverage as those vendor
   stacks or the 1% `cpu_fallback_percent_max` / 1%
   `unsupported_operator_percent_max` budgets cannot be met.

## Embedded baseline (always-on micro-NPU)

The `always_on_micro_npu_power_mw_max: 20` target sits in the Ethos-U /
Hexagon-eDSP envelope:

- ARM Ethos-U55 in a Cortex-M55 system shows latency uplifts 7x..125x and
  per-inference energy savings up to 143x vs Cortex-M-only execution
  (`ethos_u_energy_eval`). This is the kind of efficiency window required
  for a credible always-on tier.
- Streaming attention work like Folding Attention (`folding_attention_paper`)
  and WhisperKit (`whisperkit_paper`) shows that on-device speech inference
  can hit phone-class TDP if the projection / attention layers are
  attacked specifically. The always-on tier of the E1 NPU must therefore
  not be a stripped GEMM tile alone; it needs at least one fused projection
  + attention micro-kernel.

## Verifiability standard

For any benchmark claim against this landscape in E1 evidence files we
require:

- Workload name and model SHA-256.
- Precision actually used by the delegate.
- Sustained tokens/sec or sustained TOPS averaged over >=30 s.
- Sustained NPU power in W with a sampling rate.
- Skin temperature trace where relevant.
- CPU fallback percentage (target 0; budget 1%).
- Unsupported operator percentage (target 0; budget 1%).

This matches `docs/spec-db/npu-2028-target.yaml`. Any vendor number from this
file that lacks these fields is competitive context, not proof.

## Gaps

- We have no peer-reviewed paper for Hexagon NPU6's internal tile structure.
  Hexagon is the most influential mobile NPU and the most opaque. The next
  HotChips disclosure is the realistic source.
- We have no equivalent of the MediaTek CIM NPU paper. The architecture is
  asserted in product material but not documented in a peer-reviewed venue
  as of this snapshot.
- Samsung Exynos 2600 NPU internals are absent from the public record.

Where these gaps exist, we cite the vendor brief and flag the claim as a
marketing source.
