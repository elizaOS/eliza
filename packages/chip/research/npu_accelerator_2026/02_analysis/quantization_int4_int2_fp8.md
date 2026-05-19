# Quantization and low-precision evidence for E1

Date: 2026-05-19

This file maps the public quantization literature against the E1 precision
matrix in `docs/spec-db/npu-2028-target.yaml`:

```
required: int8, int4, int2, fp8, bf16, fp16, int32_accumulate
optional: fp32_accumulate, mixed_1_58_bit
```

and the existing scalar primitives in `docs/arch/npu.md`:
`DOT4_S8`, `DOT8_S4`, `DOT16_S2`, `DOT4_FP8_E4M3`, `SDOT4_S4_2_4`, plus
bounded `GEMM_S8` / `GEMM_S4` tiles.

## Picking the canonical formats

### INT8 / INT4 / INT2

For weight-only PTQ at INT4 we have multiple converging references:

- **GPTQ** (`gptq_paper`) is the canonical optimal-brain-style INT4 weight
  PTQ. Most pretrained checkpoints we want to run already have GPTQ
  weights or close cousins.
- **AWQ** (`awq_paper`) preserves outlier-aware salient weights and is
  more hardware-friendly than GPTQ at deployment because it avoids
  per-channel non-uniform group sizes.
- **SmoothQuant** (`smoothquant_paper`) defines the W8A8 deployment path
  for E1's dense INT8 tier; E1 must support per-channel weight scales and
  per-tensor activation scales.

For full INT4 (W4A4) deployment:

- **QuaRot** (`quarot_paper`) uses random Hadamard rotations to make
  activations outlier-free and enables W4A4KV4 at acceptable accuracy.
- **SpinQuant** (`spinquant_paper`) replaces the random rotation with a
  learned one and improves W4A4 accuracy by another 25 points vs.
  SmoothQuant on LLaMA-2-7B.
- **OmniQuant** (`omniquant_paper`) and **HQQ** (`hqq_repo`) provide
  reference PTQ flows we can use to validate the accuracy budget on
  internal models without retraining.

**E1 implication:** the INT4 tile must support per-group weight scales
with group size in {32, 64, 128} to match AWQ / GPTQ conventions. The INT4
activation path needs per-tensor or per-row scales and Hadamard rotation as
a compiler pass, not a hardware operator. The current `GEMM_S4` opcode
in `docs/arch/npu.md` stores two signed INT4 values per byte but does not
yet expose group-scale metadata; this is a missing field for the L2 spec.

For **INT2**:

- **BitNet b1.58** (`bitnet_b1_58_paper`, `bitnet_2b4t_hf`) defines
  ternary weights {-1, 0, +1} with 8-bit activations. The compute is
  reduced to sign-flip + sum; multiplies vanish.
- **BitNet a4.8** (`bitnet_a4_8_paper`) extends to 4-bit activations with
  3-bit KV cache.

The existing `DOT16_S2` opcode packs sixteen signed 2-bit lanes in
`[-2, 1]` using two's complement. BitNet uses `{-1, 0, +1}` ternary, not
2-bit two's complement. To support BitNet natively, the L2 INT2 tile must
add a ternary mode: either map `{-1, 0, +1}` into a 2-bit code with a
mode bit, or expose a separate `DOT_TERNARY_W_S8_A` opcode where the
weight is two-bit-encoded `{-1, 0, +1}` and the activation is INT8. This
is one of the highest-confidence missing features in the current ABI.

### FP8

E1 today has `DOT4_FP8_E4M3` only. The literature direction is:

- **MX formats** (`ocp_mx_spec`, `mx_formats_paper`, `ocp_mx_blog`,
  `ptq_mx_paper`, `microxcaling_repo`) standardize MXFP8 (E5M2 or E4M3
  per-lane), MXFP6 (E3M2 / E2M3), MXFP4 (E2M1), and MXINT8 with a shared
  E8M0 scale over 32-element blocks. This is the cross-vendor consensus
  (AMD, Arm, Intel, Meta, Microsoft, NVIDIA, Qualcomm).
- **NVIDIA Blackwell Transformer Engine** (`nvidia_blackwell_architecture`,
  `blackwell_wikipedia`) supports MXFP4 and MXFP6 natively.
- **FlashAttention-3** (`flashattention3_paper`) demonstrates that FP8
  attention is realistic and 2.6x more accurate than the naive FP8
  baseline.

**E1 implication:** the FP8 tier should expose MX semantics, not a flat
FP8 E4M3 datapath. Concretely:

- A 32-element block decoder consumes 32 FP8 lanes + one shared E8M0 scale
  byte, multiplies, and accumulates into a higher-precision (FP32 or
  INT32) accumulator. The accumulator type should be FP32 if FP8 is the
  primary use, INT32 if mixed with INT8 / INT4 dataflow.
- A `MXFP4_GEMM` op should join the L2 spec, sharing the GEMM scratchpad
  with `GEMM_S4` and `GEMM_S8`. The hardware change is per-block dequant
  rather than a new MAC pipeline.

The current scalar `DOT4_FP8_E4M3` decodes each lane to signed Q8.8 fixed
point and accumulates in Q8.8. That is good evidence of the FP8 datapath
but is not block-scaled; it should be marked as a stepping stone, not the
production format.

## Accuracy budget at each precision

The PTQ literature converges on these rough rules for transformer LLMs in
the 1B..70B range:

| Precision | Accuracy gap vs FP16 baseline | Notes |
| --- | --- | --- |
| W8A8 (SmoothQuant)            | within 0.5 pp on standard reasoning | drop-in PTQ |
| W4A16 (GPTQ / AWQ)            | within 0.5 pp                       | weight-only |
| W4A4KV4 (QuaRot / SpinQuant)  | 0.5..2 pp                           | requires Hadamard rotation pass |
| W2A8 (BitNet b1.58 native)    | within 0.5 pp                       | requires QAT, not drop-in PTQ |
| W2A4 + KV3 (BitNet a4.8)      | within 0.5..1 pp                    | requires QAT |
| MXFP6 (per-block)             | within 0.2 pp (PTQ paper)           | recommended FP format for accuracy |
| MXFP4 (per-block)             | 0.5..1 pp                           | best for memory-bound decode |

These ranges are pulled from `gptq_paper`, `awq_paper`, `smoothquant_paper`,
`quarot_paper`, `spinquant_paper`, `bitnet_b1_58_paper`, `bitnet_a4_8_paper`,
`mx_formats_paper`, and `ptq_mx_paper`. They are research-grade and assume
canonical evaluation sets. E1 evidence must measure its own accuracy
deltas on the exact deployed model and dataset before any production
claim.

## Operator coverage requirements

For the E1 INT4 tier to actually run a typical PTQ LLaMA-style model, the
hardware ABI must support:

1. **Group-scaled INT4 GEMM** with group sizes {32, 64, 128}.
2. **Per-tensor and per-row INT8 activation scales** with int32 accumulation.
3. **Hadamard rotation** as an explicit op or, more practically, as a
   weight pre-rotation done by the compiler (no HW change).
4. **2:4 sparse INT4** decode against group-scaled weights — currently the
   `SDOT4_S4_2_4` scalar primitive proves semantics but not throughput.
5. **MXFP block dequant** to share datapath with FP16 / FP32 accumulators.
6. **Per-row int32 -> int8 requantization** with optional ReLU / GELU /
   SwiGLU fusion. Only ReLU is currently exposed (`RELU4_S8`, `VRELU_S8`).

Of these, the highest-impact missing capabilities are #1 (group scales),
#5 (MX block dequant), and the GELU / SwiGLU activation that PTQ paths
universally assume.

## KV-cache quantization

`kivi_paper` and the broader survey `kv_cache_survey` show that 2-bit
asymmetric KV cache is achievable without tuning. Combined with BitNet
a4.8's 3-bit KV cache, the natural E1 KV path is **per-page asymmetric
quantization at 2 or 3 bits with per-head scales**. The hardware
implication is that the attention engine's K and V load path must support
de-quantizing from 2/3-bit packed storage to int8 or fp8 lanes on the fly.

## Recommendation summary

High confidence:

- Add per-group INT4 scales to `GEMM_S4` and to any future tile-level
  INT4 op. Group size {32, 64, 128}.
- Add an MX block-decode path to the FP8 tier, sized for 32-element
  blocks with a shared E8M0 scale. Replace the unscaled FP8 lane format
  with MXFP8.
- Add a ternary `{-1, 0, +1}` mode to `DOT16_S2` (or a new opcode) for
  BitNet.
- Specify per-head, per-page KV-cache scales as part of the attention
  engine ABI.

Medium confidence:

- Add MXFP6 alongside MXFP4 to give the compiler a "trade FP4 perf for
  FP6 accuracy" knob without leaving the MX family.
- Add a fused requantize + GELU / SwiGLU activation path.

Lower confidence (more design work needed before adoption):

- Hardware-resident Hadamard rotation for the QuaRot/SpinQuant path.
  Currently we can do this in software and avoid silicon area.
- Mixed precision per-layer scheduler (BF16 attention + INT4 MLP, etc.);
  this is a compiler decision that the hardware must merely allow.
