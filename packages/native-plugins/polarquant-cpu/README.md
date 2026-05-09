# polarquant-cpu

Reference C scalar kernels and GGUF converter for the on-device
PolarQuant Q4 weight format (`block_q4_polar`, GGML type tag
`Q4_POLAR=45`).

This is the foundation drop. NEON / AVX2 / Metal kernels and the
upstream registration into the
[Apothic-AI/llama.cpp-1bit-turboquant](https://github.com/Apothic-AI/llama.cpp-1bit-turboquant)
fork are explicitly out of scope for this session and tracked under
"Next-session work" below.

## What is in here

| File | Purpose |
|---|---|
| `include/polarquant/polar_centroids.h` | 16 Lloyd-Max centroids for N(0,1), generated. |
| `include/polarquant/polar_block.h` | `block_q4_polar` layout (locked) + fp16<->fp32 helpers. |
| `include/polarquant/polarquant.h` | Public API: encoder, decoder, dot product, QJL signs. |
| `src/polar_hadamard.c` | In-place size-128 Walsh-Hadamard butterfly. |
| `src/polar_qjl.c` | Deterministic per-block +/-1 sign vector (xorshift32). |
| `src/polar_quantize_ref.c` | `quantize_row_q4_polar_ref` (norm -> WHT -> bucketize -> pack + 1-bit residual). |
| `src/polar_dequantize_ref.c` | `dequantize_row_q4_polar_ref` (unpack -> centroid LUT -> inverse WHT -> rescale). |
| `src/polar_dot_ref.c` | `ggml_vec_dot_q4_polar_q8_0_ref` (matmul kernel; mirrors `ggml_vec_dot_q4_K_q8_K`). |
| `test/polar_roundtrip_test.c` | Round-trip a float[128] and check rel-L2 against the Python reference's measured rate. |
| `test/polar_dot_test.c` | Dot product against an unquantized fp32 reference, same tolerance. |
| `scripts/gen_centroids.py` | Regenerates `polar_centroids.h` bit-for-bit from the Lloyd-Max solver in `polar_quant.py`. |
| `scripts/polarquant_to_gguf.py` | Pack a PolarQuant safetensors sidecar into a Q4_POLAR=45 GGUF. |
| `scripts/test_converter.py` | Synthesize a 128x128 linear, encode + convert + read back. |

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

## Validation results (this session)

| Test | Status | Notes |
|---|---|---|
| `polar_roundtrip` | PASS | rel-L2 ~ 0.091 (no QJL) / 0.099 (with QJL); matches Python reference's measured per-block error. |
| `polar_dot` | PASS | rel-error ~ 0.066 vs fp32 ref; same Python ref bound. |
| `test_converter.py` | PASS | 1 layer, 128 blocks, 82-byte records bit-identical to direct `pack_layer()`. |

The per-block reconstruction error (~9-10%) is *not* a quality knob.
PolarQuant Q4's downstream perplexity claim (PPL Δ ≤ +0.05 vs FP16) is
end-to-end and depends on the model's tolerance for that per-block
distortion across many overlapping projections; that gate is the
calibration parity test in next-session work.

## Next-session work (NOT done in this session)

- **NEON SIMD encoder/decoder/dot.** The reference kernels here are
  scalar.  NEON ports go in `src/polar_*_neon.c` and are guarded by
  a build flag (`POLARQUANT_HAVE_NEON`) so this directory keeps
  compiling on x86 dev hosts.
- **AVX2 path** for cuttlefish + dev workstations.
- **Apothic-AI/llama.cpp-1bit-turboquant integration.**
  - Register `GGML_TYPE_Q4_POLAR = 45` in `ggml/src/ggml-common.h`.
  - Wire the type traits in `ggml/src/ggml-cpu/ggml-cpu.c`
    (`type_traits[GGML_TYPE_Q4_POLAR]`).
  - Drop the C kernels here into `ggml/src/ggml-cpu/quants-polar.c`
    (or analogous), preserving the function signatures so the
    integration patch is a near-mechanical copy.
  - If the matmul needs a custom `GGML_OP` (it shouldn't; Q4_POLAR
    plugs into the existing mul_mat_q4_X paths), add the dispatch.
- **Metal kernel** in the fork's `ggml-metal.metal`:
  `kernel_get_rows_q4_polar`, `kernel_mul_mv_q4_polar_f32`.
- **Calibration parity test** against `polarquant_apply.py` on a real
  Qwen3-0.6B checkpoint: convert to GGUF, run llama.cpp on it, and
  compare PPL on a fixed wikitext-2 chunk against the Python
  reconstruction's PPL.
- **QJL residual sign vector parity.** This session's reference uses a
  C xorshift32 PRNG to derive the per-block +/-1 sign vector.  The
  Python reference uses `torch.randint(seed=42)`, which is not
  portable across torch versions.  The integration step must pick one
  of:
  1. Recompute the sign vector in Python during conversion using the
     C xorshift32 algorithm and re-derive the residual bits, OR
  2. Embed the sign vector in GGUF metadata (16 bytes) and have the
     decoder use the embedded vector verbatim.
  Path (2) is simpler and what the converter is wired to support
  (see `polarquant.use_qjl` + the reserved 15 bytes in `qjl[]`).

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
