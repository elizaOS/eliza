/* turboquant.h — public C API for the standalone TurboQuant CPU library.
 *
 * Mirrors the layouts and codebooks that the elizaOS llama.cpp fork
 * registers as `GGML_TYPE_TBQ3_0` / `GGML_TYPE_TBQ4_0` /
 * `GGML_TYPE_TBQ3_TCQ`. The fork lives at
 * `plugins/plugin-local-inference/native/llama.cpp/` and the
 * authoritative ggml-side definitions are:
 *
 *   ggml/include/ggml.h
 *     GGML_TYPE_TBQ3_0    = 44
 *     GGML_TYPE_TBQ4_0    = 45
 *     GGML_TYPE_TBQ3_TCQ  = 48
 *
 *   ggml/src/ggml-common.h
 *     block_tbq3_0  (14 B = uint16_t d + 12 B 3-bit codes)
 *     block_tbq4_0  (18 B = uint16_t d + 16 B 4-bit codes)
 *
 * The reference math is shared with
 * `plugins/plugin-local-inference/native/reference/turbo_kernels.{c,h}`
 * (`eliza_block_tbq{3,4}_0`, `eliza_quantize_tbq{3,4}_block`,
 * `eliza_tbq{3,4}_decode_block_uncond`). This standalone library
 * exists so user-space tooling (GGUF converters, off-llama.cpp
 * benchmarks, parity tests) can consume the same kernels without
 * pulling the full ggml dependency in — exact parity with `qjl-cpu`
 * and `polarquant-cpu`.
 *
 * STATUS: scaffold. The reference kernels are stubbed against the
 * shared turbo_kernels.{c,h} primitives; SIMD lanes and the GGUF
 * converter are not wired yet. See AGENTS.md.
 */

#ifndef TURBOQUANT_TURBOQUANT_H
#define TURBOQUANT_TURBOQUANT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- block dimensions (locked, must match the fork's QK_TBQ) ------- */

#define TBQ_QK         32
#define TBQ_PER_HEAD   (128 / TBQ_QK)   /* 4 32-blocks per 128-row */

/* ---- block layouts (byte-identical to ggml-common.h) --------------- */

typedef struct {
    uint16_t d;                 /* fp16 RMS scale after preconditioning */
    uint8_t  qs[TBQ_QK * 3 / 8];/* 12 bytes: 32 3-bit codes, LSB-first  */
} tbq_block_tbq3_0;             /* 14 bytes — fork block_tbq3_0         */

typedef struct {
    uint16_t d;                 /* fp16 RMS scale after preconditioning */
    uint8_t  qs[TBQ_QK / 2];    /* 16 bytes: 32 4-bit codes, q4_0-style */
} tbq_block_tbq4_0;             /* 18 bytes — fork block_tbq4_0         */

/* ---- codebooks (canonical values from the fork) -------------------- */

extern const float TBQ3_CODEBOOK[8];
extern const float TBQ4_CODEBOOK[16];
extern const int8_t TBQ_SIGNS_32[32];

/* ---- block encode / decode (scalar reference) ----------------------
 *
 * encode: 32 fp32 floats -> one block.
 *   1. apply per-element ±1 sign vector,
 *   2. in-place size-32 Walsh-Hadamard butterfly + 1/sqrt(32) scale,
 *   3. compute RMS, store as fp16 in `d`,
 *   4. nearest-codebook quantise each element.
 *
 * decode: one block -> 32 fp32 floats (real-space, post-uncondition).
 *   1. codebook lookup × `d`,
 *   2. inverse Hadamard-32,
 *   3. ±1 sign flip.
 *
 * Bit-exact to dequantize_row_tbq{3,4}_0 in the fork's
 * ggml/src/ggml-quants.c. */

void tbq_quantize_tbq3_block(const float src[32], tbq_block_tbq3_0 * dst);
void tbq_quantize_tbq4_block(const float src[32], tbq_block_tbq4_0 * dst);

void tbq_decode_tbq3_block(const tbq_block_tbq3_0 * src, float dst[32]);
void tbq_decode_tbq4_block(const tbq_block_tbq4_0 * src, float dst[32]);

/* ---- fp16 helpers (same conversion as eliza_fp{16,32}_to_fp{32,16}) - */

uint16_t tbq_fp32_to_fp16(float f);
float    tbq_fp16_to_fp32(uint16_t h);

#ifdef __cplusplus
}
#endif

#endif /* TURBOQUANT_TURBOQUANT_H */
