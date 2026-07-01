# e1 NPU quantization pipeline

The quantization pipeline produces calibration manifests consumed by the
[elizanpu IREE backend](iree-eliza-npu.md). Five formats target the NPU's
hardware opcodes:

| Format | Hardware path | Default use |
| --- | --- | --- |
| **PTQ INT8** (per-channel weights / per-tensor activations) | `GEMM_S8`, `DOT4_S8` | dense default for most CNN / small transformer |
| **AWQ INT4** weight-only | `DOT8_S4` | LLM weights (best PPL at 3-4 bit) |
| **GPTQ INT4** weight-only | `DOT8_S4` | fallback for non-LLM small-batch |
| **FP8 E4M3** | `DOT4_FP8_E4M3` (scalar contract today; tensor path BLOCKED) | long-context LLM where INT8/INT4 PPL degrades |
| **2:4 structured sparse INT4** | `SDOT4_S4_2_4` | dense matmul layers with 50% magnitude pruning |
| **INT2 BitNet** | `DOT16_S2` (scalar contract today; tensor path BLOCKED) | experimental ultra-low-precision LLM |

## Manifest schemas

Every calibrator emits a JSON manifest with a versioned schema string:

- `eliza.ptq_int8_manifest.v1`
- `eliza.awq_int4_manifest.v1`
- `eliza.gptq_int4_manifest.v1`
- `eliza.fp8_e4m3_manifest.v1`
- `eliza.sparse_2_4_int4_manifest.v1`
- `eliza.int2_bitnet_manifest.v1`

The IREE backend dispatches on the schema string at compile time.

## Calibration flow

1. Run a representative batch through the model in fp32.
2. For each weight tensor, collect per-channel max-abs.
3. For each activation tensor, collect a sample of absolute values.
4. Call the matching calibrator's `record_*` methods.
5. Call `build_manifest()` and write the JSON to disk.
6. Pass to `iree-compile --iree-input-quantization-manifest=<path>`.

## Status

- All six calibrators committed under `compiler/quantization/`.
- Unit tests pass (8/8) in repo CI without torch installed.
- Real PyTorch model integration: BLOCKED on torch + IREE inside the
  canonical Linux container.

## Evidence gate

[`docs/evidence/compiler/quantization-evidence.yaml`](../evidence/compiler/quantization-evidence.yaml).
