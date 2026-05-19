# polarquant-cpu

C reference + AVX2 + NEON kernels and a GGUF converter for the
on-device PolarQuant Q4 weight format (`block_q4_polar`, GGML type
tag `Q4_POLAR=45`).

The standalone static library here is the behavioural source of truth
for the kernels.  Drop-in patches for the
[Apothic-AI/llama.cpp-1bit-turboquant](https://github.com/Apothic-AI/llama.cpp-1bit-turboquant)
fork live under `fork-integration/` (separate `quants-polar.{h,c}` +
`.patch` deltas for `ggml-common.h`, `ggml.h`, `ggml-cpu.c`,
`ggml-quants.c`, and `ggml/src/ggml-cpu/CMakeLists.txt`).

## What is in here

| File | Purpose |
|---|---|
| `include/polarquant/polar_centroids.h` | 16 Lloyd-Max centroids for N(0,1), generated. |
| `include/polarquant/polar_block.h` | `block_q4_polar` layout (locked) + fp16<->fp32 helpers. |
| `include/polarquant/polarquant.h` | Public API: encoder, decoder, dot product, QJL signs, SIMD dispatcher. |
| `src/polar_hadamard.c` | In-place size-128 Walsh-Hadamard butterfly (scalar). |
| `src/polar_qjl.c` | Deterministic per-block +/-1 sign vector (xorshift32). |
| `src/polar_quantize_ref.c` | `quantize_row_q4_polar_ref` (norm -> WHT -> bucketize -> pack + 1-bit residual). |
| `src/polar_dequantize_ref.c` | `dequantize_row_q4_polar_ref` (unpack -> centroid LUT -> inverse WHT -> rescale). |
| `src/polar_dot_ref.c` | `ggml_vec_dot_q4_polar_q8_0_ref` (matmul kernel; mirrors `ggml_vec_dot_q4_K_q8_K`). |
| `src/polar_dequantize_avx2.c` | AVX2 dequantizer (FMA-vectorised Hadamard butterfly). |
| `src/polar_dot_avx2.c`        | AVX2 dot product against Q8_0 activations. |
| `src/polar_dequantize_neon.c` | ARM NEON dequantizer (FMA-vectorised Hadamard butterfly). |
| `src/polar_dot_neon.c`        | ARM NEON dot product against Q8_0 activations. |
| `src/polar_dispatch.c`        | Compile-time `dequantize_row_q4_polar` / `ggml_vec_dot_q4_polar_q8_0` dispatcher. |
| `test/polar_roundtrip_test.c` | Round-trip a float[128] and check rel-L2 against the Python reference's measured rate. |
| `test/polar_dot_test.c`       | Dot product against an unquantized fp32 reference, same tolerance. |
| `test/polar_simd_parity_test.c` | SIMD-vs-scalar parity over 100 random blocks (dequant max-abs <= 5e-5, dot rel-err <= 1e-5). |
| `scripts/gen_centroids.py`    | Regenerates `polar_centroids.h` bit-for-bit from the Lloyd-Max solver in `polar_quant.py`. |
| `scripts/polarquant_to_gguf.py` | Pack a PolarQuant safetensors sidecar into a Q4_POLAR=45 GGUF. |
| `scripts/test_converter.py`   | Synthesize a 128x128 linear, encode + convert + read back. |
| `fork-integration/`           | In-fork drop-in: `quants-polar.{h,c}` + `*.patch` for the apothic llama.cpp fork. |

## Block format (locked)

```c
#define QK_POLAR 128
#define QJL_RESIDUAL_BYTES (QK_POLAR / 8)   // 16 bytes

typedef struct __attribute__((packed)) {
    polar_fp16_t d;                          // 2  bytes (per-block L2 norm)
    uint8_t      qs[QK_POLAR / 2];           // 64 bytes (4-bit codes, 2 per byte)
    uint8_t      qjl[QJL_RESIDUAL_BYTES];    // 16 bytes (1-bit residual per block)
} block_q4_polar;

// 82 bytes/block.  5.125 bpw with QJL, 4.125 bpw without.
```

`qs`: low nibble = even-index code, high nibble = odd-index code (matches
the layout llama.cpp's existing 4-bit kernels assume so SIMD unpacking
ports cleanly).

`qjl[0]` bit 0 holds the per-block residual sign; bytes 1..15 are
reserved for a future per-coordinate residual without breaking the
on-disk size.

## Build + test

```bash
cmake -B build -S .
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## Centroid regeneration

The committed centroid header is the bit-for-bit output of:

```bash
python scripts/gen_centroids.py > include/polarquant/polar_centroids.h
```

The Lloyd-Max iteration is deterministic (16 levels, 100 iterations,
fixed initial boundaries on [-4, 4]).  `gen_centroids.py` mirrors
`packages/training/scripts/quantization/polarquant/polar_quant.py::_compute_lloyd_max_centroids`
exactly.

## GGUF converter

```bash
python scripts/polarquant_to_gguf.py \
  --sidecar  /path/to/polarquant_artifacts.safetensors \
  --base-model /path/to/base/hf/model_dir \
  --output   /path/to/out.gguf
```

Reads the sidecar's `<layer>.codes` (int8), `<layer>.norms` (fp16),
optional `<layer>.qjl` (uint8) tensors; packs each layer into
`block_q4_polar` records; and writes a GGUF where every quantized
tensor is typed `Q4_POLAR=45`.  Header metadata:

| Key | Value |
|---|---|
| `polarquant.block_size` | `128` |
| `polarquant.bits` | `4` |
| `polarquant.use_qjl` | `0` / `1` |
| `polarquant.qjl_seed` | `42` |
| `polarquant.qjl_correction` | `0.5` |
| `polarquant.rotation` | `"wht-128"` |
| `polarquant.upstream_commit` | PolarQuant commit pin |

The decoder is expected to verify these against its compile-time
constants and refuse to load on any mismatch.

## Test

```bash
python scripts/test_converter.py
```

Synthesizes a 128x128 fp32 weight, runs the vendored PolarQuant
encoder over it, drives the converter, and reads the GGUF back via
`gguf.GGUFReader` (with `Q4_POLAR=45` patched into the enum to
mirror what the upstream registration step will do).

## Validation results

| Test | Status | Notes |
|---|---|---|
| `polar_roundtrip` | PASS | rel-L2 ~ 0.091 (no QJL) / 0.099 (with QJL); matches Python reference's measured per-block error. |
| `polar_dot` | PASS | rel-error ~ 0.066 vs fp32 ref; same Python ref bound. |
| `polar_simd_parity` | PASS | AVX2 vs scalar reference: dequant max_abs <= 5e-7, mean_abs <= 3e-8; dot rel-err <= 2e-7 across 100 random blocks (use_qjl on/off).  NEON path cross-compiles cleanly under `aarch64-linux-gnu`; runtime gate runs on aarch64 CI. |
| `test_converter.py` | PASS | 1 layer, 128 blocks, 82-byte records bit-identical to direct `pack_layer()`. |

The per-block reconstruction error (~9-10%) is *not* a quality knob.
PolarQuant Q4's downstream perplexity claim (PPL Δ ≤ +0.05 vs FP16) is
end-to-end and runs once a real Q4_POLAR model GGUF is built through
the integration flow described in `fork-integration/README.md`.

## Architecture-specific kernels

| Kernel | Scalar | AVX2 | NEON |
|---|---|---|---|
| `quantize_row_q4_polar` (encoder) | yes | -- (convert-time only) | -- |
| `dequantize_row_q4_polar` (decoder) | yes | yes | yes |
| `ggml_vec_dot_q4_polar_q8_0` (dot) | yes | yes | yes |

The encoder stays scalar because it runs once per weight tensor at
GGUF convert time, not in the inference hot path.  The decoder + dot
are SIMD-dispatched.  The dispatcher itself
(`src/polar_dispatch.c`) is `#if`-guarded by `POLARQUANT_HAVE_AVX2` /
`POLARQUANT_HAVE_NEON` (set by `CMakeLists.txt`) and falls back to the
scalar reference when neither is available — useful for non-x86 /
non-aarch64 dev hosts.

## In-fork integration

The Apothic llama.cpp fork integration (registers `Q4_POLAR=45`,
wires the type-traits dispatch) is staged in `fork-integration/`:

- `quants-polar.{h,c}` — drop-in for `ggml/src/ggml-cpu/`,
  scalar + AVX2 + NEON.
- `*.patch` — the deltas for `ggml-common.h`, `ggml.h`, `ggml-cpu.c`,
  `ggml-quants.c`, and `ggml/src/ggml-cpu/CMakeLists.txt`.
- `fork-integration/README.md` — the order of operations + the
  `test-quantize-fns` gate the vendor must run before we bump the
  pin in `compile-libllama.mjs`.

This standalone library remains the behavioural source of truth (it
has the unit tests + parity gates).  The in-fork file is a
transcription with llama.cpp's own typedefs (`ggml_fp16_t`,
`block_q8_0`).  Math is identical; only the type names differ.

## QJL residual sign vector parity

The Python reference uses `torch.randint(seed=42)`, which is not
portable across torch versions.  Both the standalone library and the
in-fork TU (`fork-integration/quants-polar.c`) use the deterministic
C xorshift32 stream defined in `src/polar_qjl.c`.  The GGUF converter
at `scripts/polarquant_to_gguf.py` is responsible for recomputing the
QJL bits against the same xorshift32 stream when packing the sidecar,
so encoder + decoder + converter all agree on the same 128-bit sign
vector.

## Related files in this repo

- `docs/porting/on-device-quantization-porting-plan.md` -- the design
  spec this implementation follows ("PolarQuant block_q4_polar GGML
  quant type").
- `packages/training/scripts/quantization/polarquant/polar_quant.py` --
  the bit-exact Python reference for the Lloyd-Max centroid solver,
  the Hadamard rotation, and the QJL residual.
- `packages/training/scripts/quantization/polarquant_apply.py` -- the
  orchestrator that produces the safetensors sidecar this converter
  consumes.
- `packages/app-core/scripts/aosp/compile-libllama.mjs` -- the
  toolchain that will build the `libllama.so` carrying the eventual
  Q4_POLAR kernel registration.
