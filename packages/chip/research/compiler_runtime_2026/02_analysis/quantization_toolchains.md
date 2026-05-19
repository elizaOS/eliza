# Quantization toolchains and their operator assumptions (2026-05-19)

Research-only summary of the software toolchains that produce low-bit models
the E1 NPU could in principle execute. The E1 RTL today implements scalar
opcodes covering INT8 (`DOT4_S8`, `GEMM_S8`), INT4 (`DOT8_S4`, `GEMM_S4`,
`SDOT4_S4_2_4`), INT2 (`DOT16_S2`), and FP8 E4M3 (`DOT4_FP8_E4M3`) per
`docs/arch/npu.md`. None of these toolchains have been integrated; this is
a map for future work.

## 1. INT8 PTQ / QAT

- **AIMET** (`github.com/quic/aimet`) — Qualcomm's open toolkit. Implements
  AdaRound, Bias Correction (BC), Cross-Layer Equalization (CLE), and a
  large bag of QAT recipes. Operator assumption: standard NN ops (conv, FC,
  matmul, LayerNorm, GELU, softmax) with per-tensor or per-channel INT8
  weight + INT8 activation. Output is a QDQ-annotated graph compatible with
  ORT and QNN.
- **PyTorch FX Quantization / `torch.ao.quantization`** — first-party PyTorch
  PTQ/QAT path. Now feeds **ExecuTorch** delegates.
- **TFLite QuantizationAware** + **AI Edge Torch** — Google's PTQ path,
  producing INT8-quantized LiteRT flatbuffers; AI Edge Torch additionally
  supports INT4 weight-only for LLMs.
- **SmoothQuant** (Xiao et al., ICML 2023) — migrates activation outliers
  into weight scales so that the resulting activations fit INT8. Required
  precondition for INT8 transformer activations.
- **LLM.int8()** (Dettmers et al., NeurIPS 2022) — first widely deployed
  INT8 LLM recipe; uses mixed precision for outlier features.

Operator assumption baseline for INT8 on transformers: matmul + add + layer
norm + softmax + element-wise (GELU/Sigmoid) + KV concat. E1's
`GEMM_S8` covers matmul; everything else is currently absent and would either
fall back to host CPU or require new opcodes.

## 2. INT4 weight-only

This is the dominant LLM serving precision in 2026 on both server and
mobile. Methods:

- **GPTQ** (Frantar et al., ICLR 2023) — second-order Hessian-based
  per-column weight calibration. Used by `auto-gptq`, llama.cpp's `Q4_K`
  family, mlc-llm.
- **AWQ** (Lin et al., MLSys 2024) — activation-statistics-driven scaling.
  Now standard in vLLM, mlc-llm, llama.cpp.
- **HQQ** — calibration-free INT4 (and INT2/INT3) quantization, fast
  deployment.
- **OmniQuant** (Shao et al., ICLR 2024) — learnable clipping + smoothing,
  intermediate complexity.
- **Brevitas** (Xilinx) — PyTorch QAT library with flexible bit widths,
  including INT4 and FP8.

Operator assumption: weight-only INT4 means the matmul kernel does the
INT4 × FP16/BF16/INT8 dequantize-on-the-fly. The E1 `GEMM_S4` opcode
matches a fully-quantized W4A4 INT32-output design — i.e. activations are
also INT4 in scratchpad. Weight-only INT4 with FP16 activations is **not**
what `GEMM_S4` does today; the compiler must either upcast weights to INT8
in software or grow a W4A16-style opcode.

## 3. Fully-quantized INT4 (W4A4) — SpinQuant / QuaRot / Atom

W4A4 is the harder problem because activations have outliers. The
production-quality methods in 2026:

- **SpinQuant** (Liu et al., ICLR 2025) — learned rotation matrices that
  spread activation magnitude before quantization. Maintains accuracy at
  W4A4 / W4A8 on Llama-class models.
- **QuaRot** (Ashkboos et al., NeurIPS 2024) — random-rotation
  preprocessing that proves outlier-free W4A4 KV4 inference is possible.
  Companion theory to SpinQuant.
- **Atom** (Zhao et al., MLSys 2024) — W4A4 with mixed-precision outlier
  handling and reorder-based KV-cache quantization.
- **RPTQ / KIVI** — KV-cache-specific 2-bit / asymmetric quantization
  recipes; reduce memory by 4-8x.

Operator assumption: the model graph carries explicit per-token /
per-channel scale and zero-point tensors; the matmul kernel consumes
quantized inputs and produces INT32 results that get re-scaled and
re-quantized before the next layer. This matches the `GEMM_S4` opcode's
INT32 accumulator output but exposes that **E1 has no rescale / requantize
opcode** — that work happens on host CPU today.

## 4. INT2 / 1.58-bit / BitNet

- **BitNet b1.58** (Ma et al., 2024) — ternary {-1, 0, 1} weights and INT8
  activations, claimed near-FP16 accuracy at large scale.
- **HQQ INT2** — calibration-free INT2 weight quantization, lower accuracy
  but faster deployment.
- **OmniQuant** has INT2-W4 variants.

Operator assumption: ternary or 2-bit signed weights, INT8 (or INT4)
activations, per-tensor or per-channel scale, INT32 accumulation. E1's
`DOT16_S2` matches the signed-INT2 × signed-INT2 product shape but is a
**scalar** dot, not a GEMM tile. To run BitNet on E1 today the compiler
must currently emit a series of `DOT16_S2` issues, which is far below the
sustained-TOPS the `npu-2028-target.yaml` calls for.

## 5. FP8 (E4M3 / E5M2)

- **OCP FP8 spec** (Micikevicius et al., 2022) — defines E4M3 (more
  precision) and E5M2 (more range) FP8 formats now adopted by NVIDIA, AMD,
  Intel, Qualcomm.
- **NVIDIA Transformer Engine** — mixed-precision FP8 training/inference
  reference design. Maintains per-tensor scaling factors that update during
  training.
- **OCP Microscaling Formats** (MX, 2023) — adds block-scaling FP6 / FP4 /
  INT8 variants on top of FP8. Adopted across the industry as the path
  beyond FP8 for inference.

Operator assumption: FP8 GEMM accumulates in FP32 (or BF16/FP16), with a
per-tensor or per-block scale. E1's `DOT4_FP8_E4M3` opcode performs FP8 ×
FP8 → Q8.8 fixed-point — useful as a datapath validation but **not** the
shape that any production FP8 toolchain expects. Closing this gap requires
either an FP32 (or BF16) accumulator path, or a documented Q8.8 conversion
recipe with calibration support.

## 6. Block / microscaling formats (MX-FP6, MX-FP4, MX-INT8)

The OCP MX spec is the path most NPU and GPU vendors are converging on for
2026-2028 inference (and increasingly training). Key shape: 32-element
blocks share a single 8-bit (E8M0) scale, individual elements are FP8 / FP6
/ FP4 / INT8. The compiler must:

1. Convert per-channel-scale weights into MX block-scale layout.
2. Emit blocked GEMM tiles that consume both the data and the per-block
   scale operand.
3. Optionally requantize activations across blocks.

E1 today has no microscaling support — neither the RTL opcodes nor the
compiler. This is the largest precision-format gap if E1 wants to land on
the same precision spectrum as 2028 flagship NPUs.

## 7. KV-cache quantization

KV-cache is the dominant memory term for LLM decode at long contexts. The
toolchain expectation:

- **KIVI** — per-channel keys + per-token values, 2-bit quantization,
  tuning-free.
- **Atom**'s reorder-based KV quant — INT4 KV with outlier handling.
- **vLLM PagedAttention** — block-paged KV storage that is precision-agnostic
  but assumes contiguous-in-block tensors.

Operator assumption: the attention kernel must consume quantized K and V
tensors with embedded scales, dequantize per block, and accumulate in
higher precision. E1's `attention_qk` and `attention_av` smoke schemas
today do not represent quantized KV tensors or any block-paged layout;
both must be added before claiming long-context LLM decode coverage.

## 8. Summary table: precision vs E1 readiness

| Precision class      | Software status (2026) | E1 RTL opcode     | E1 compiler status | Gap                                                                 |
| -------------------- | ---------------------- | ----------------- | ------------------ | ------------------------------------------------------------------- |
| INT8 W8A8            | Production             | `GEMM_S8`         | Tile smoke only    | No rescale opcode, no end-to-end transformer lowering                |
| INT4 W4A16 (weight)  | Dominant for LLMs      | none              | None               | Need dequantize-on-the-fly path or new opcode                        |
| INT4 W4A4            | Production via SpinQuant/QuaRot | `GEMM_S4` | Tile smoke only    | No requantize, no rotation preprocessing, scalar only                |
| INT2 ternary (BitNet)| Research-to-early-prod | `DOT16_S2`        | Scalar smoke only  | No INT2 GEMM tile, no compiler path                                  |
| FP8 E4M3             | Production on H100/Blackwell | `DOT4_FP8_E4M3` (Q8.8 accum) | Scalar smoke only | Q8.8 accumulator is wrong shape for FP8 GEMM                         |
| MX-FP6 / FP4         | Adopted by 2028 flagships | none           | None               | Needs both RTL block-scale support and compiler block layout         |
| KV INT4 / INT2       | Production via KIVI / Atom | none           | None               | Need quantized attention path and block-paged KV layout              |

This table feeds directly into `03_implementation/e1_compiler_path.md`.
