/* DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
 *
 * Reference C declarations for turbo3 / turbo4 / turbo3_tcq KV cache
 * quantization, mirroring buun-llama-cpp's CPU reference at
 * ggml/src/ggml-turbo-quant.c (commit 6575873e9c4872709d374d854b583cfaa270caff).
 *
 * The block layouts follow ggml-common.h exactly:
 *   block_turbo3_0    : 14 bytes (norm fp16, qs[8], signs[4]),     QK=32
 *   block_turbo4_0    : 18 bytes (norm fp16, qs[16]),               QK=32
 *   block_turbo3_tcq  : 52 bytes (norm fp16, qs[49], pad),          QK=128
 */

#ifndef ELIZA_TURBO_KERNELS_REFERENCE_H
#define ELIZA_TURBO_KERNELS_REFERENCE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ELIZA_QK_TURBO3      32
#define ELIZA_QK_TURBO3_GROUP 128
#define ELIZA_QK_TURBO4      32
#define ELIZA_QK_TURBO4_GROUP 128
#define ELIZA_QK_TURBO3_TCQ 128

typedef struct {
    uint16_t norm;            /* fp16 storage as raw uint16_t bits */
    uint8_t  qs[8];           /* QK_TURBO3/4: 4 indices per byte (low 2 bits) */
    uint8_t  signs[4];        /* QK_TURBO3/8: 1 sign-bit per element (3rd bit of 3-bit index) */
} eliza_block_turbo3_0;       /* 14 bytes */

typedef struct {
    uint16_t norm;            /* fp16 */
    uint8_t  qs[16];          /* QK_TURBO4/2: first 16 low nibbles, last 16 high nibbles */
} eliza_block_turbo4_0;       /* 18 bytes */

/* ---------- Fork-exact TBQ V-cache blocks (block_tbq3_0 / block_tbq4_0) ----------
 *
 * These mirror the on-fork ggml-common.h `block_tbq3_0` (14 B) and
 * `block_tbq4_0` (18 B) layouts that the V-cache uses inside
 * GGML_OP_FUSED_ATTN_QJL_TBQ. They differ from eliza_block_turbo3_0 above:
 *   - 32-element Hadamard preconditioning (not the 128-element FWHT/seed-42
 *     rotation of the turbo3 K-cache),
 *   - per-32-block RMS scale `d` (not a per-128-group L2 norm correction),
 *   - the fork TBQ codebooks (`{-2.1519457, ...}` for 3-bit, `{-2.7321365,
 *     ...}` for 4-bit), and a *decode-side uncondition* step (Hadamard-32
 *     followed by the fixed ±1 sign flip) so the dequantized output lands
 *     back in real head-dim space — the fused V-mix needs the real V vector,
 *     not the rotated one.
 *
 * eliza_block_turbo4_0 above is byte-identical to block_tbq4_0 (uint16_t d +
 * 16 code bytes); the only difference is the codebook + the missing
 * uncondition step in eliza_dequantize_turbo4_block (which the standalone
 * pre-rotated-Q TBQ4 score path deliberately omits). The fused-attn path
 * uses eliza_tbq4_decode_block_uncond / eliza_block_tbq4_0 instead. */

#define ELIZA_QK_TBQ 32
#define ELIZA_TBQ_PER_HEAD (128 / ELIZA_QK_TBQ)   /* 4 32-blocks per head row */

typedef struct {
    uint16_t d;                       /* fp16 block RMS after preconditioning */
    uint8_t  qs[ELIZA_QK_TBQ * 3 / 8];/* 12 bytes: 32 3-bit codes, LSB-first */
} eliza_block_tbq3_0;                 /* 14 bytes — matches fork block_tbq3_0 */

typedef struct {
    uint16_t d;                       /* fp16 block RMS after preconditioning */
    uint8_t  qs[ELIZA_QK_TBQ / 2];    /* 16 bytes: 32 4-bit codes, q4_0 packing */
} eliza_block_tbq4_0;                 /* 18 bytes — matches fork block_tbq4_0 */

extern const float ELIZA_TBQ3_CODEBOOK[8];
extern const float ELIZA_TBQ4_CODEBOOK[16];
extern const int8_t ELIZA_TBQ_SIGNS_32_FORK[32];

/* Encode 32 floats into one block (preconditioned + nearest-codebook). */
void eliza_quantize_tbq3_block(const float src[32], eliza_block_tbq3_0 * dst);
void eliza_quantize_tbq4_block(const float src[32], eliza_block_tbq4_0 * dst);

/* Decode one block back to 32 real-space floats (codebook lookup, Hadamard-32
 * uncondition, ±1 sign flip — bit-exact to dequantize_row_tbq3_0 /
 * dequantize_row_tbq4_0 in the fork's ggml-quants.c). */
void eliza_tbq3_decode_block_uncond(const eliza_block_tbq3_0 * src, float dst[32]);
void eliza_tbq4_decode_block_uncond(const eliza_block_tbq4_0 * src, float dst[32]);

typedef struct {
    uint16_t norm;            /* fp16 */
    uint8_t  qs[49];          /* 6 prefix bits + 128*3 = 390 bits */
    uint8_t  pad;             /* alignment */
} eliza_block_turbo3_tcq;     /* 52 bytes */

/* fp16 helpers. We store norms as raw IEEE-754 binary16 bit patterns. */
uint16_t eliza_fp32_to_fp16(float f);
float    eliza_fp16_to_fp32(uint16_t h);

/* Constant tables (exposed so verification harnesses can match shaders bit-for-bit). */
extern const float ELIZA_TURBO_CENTROIDS_3BIT[8];
extern const float ELIZA_TURBO_MID_3BIT[7];
extern const float ELIZA_TURBO_CENTROIDS_4BIT[16];
extern const float ELIZA_TURBO_MID_4BIT[15];
extern const float ELIZA_TURBO_WHT_SIGNS1[128];
extern const float ELIZA_TURBO_WHT_SIGNS2[128];
extern const float ELIZA_TURBO3_TCQ_CODEBOOK[512];

/* Forward FWHT-based rotation used by the CUDA / Metal / Vulkan paths.
 * NOTE: this is NOT the same as the dense Gram-Schmidt rotation used in
 * ggml-turbo-quant.c's CPU reference. The GPU paths use a Fast Walsh-Hadamard
 * Transform with seed=42 sign vectors (from ggml-metal/turbo-wht.h). The CPU
 * reference uses a 128x128 orthonormal matrix (also seed=42, but a different
 * generator). For numerical comparison the verification harness must use this
 * FWHT path, NOT dequantize_row_turbo*_0() from ggml-turbo-quant.c. */
void eliza_turbo_rotate_forward(float x[128]);

/* Block-level quantize / dequantize (fp32 in, fp32 out). */
void eliza_quantize_turbo3_group(const float src[128], eliza_block_turbo3_0 dst[4]);
void eliza_dequantize_turbo3_group(const eliza_block_turbo3_0 src[4], float dst[128]);

void eliza_quantize_turbo4_block(const float src[128], eliza_block_turbo4_0 dst[4]);
void eliza_dequantize_turbo4_block(const eliza_block_turbo4_0 src[4], float dst[128]);

/* turbo3_tcq: full Viterbi encoder is O(128 * 512). Provided here for fixture
 * generation — slow, but correct relative to the CUDA Viterbi pass. */
void eliza_quantize_turbo3_tcq_block(const float src[128], eliza_block_turbo3_tcq * dst);
void eliza_dequantize_turbo3_tcq_block(const eliza_block_turbo3_tcq * src, float dst[128]);

/* Q · K dequantized dot product helpers (used by verification harness). Q is
 * fp32 length 128; the K block is one quantized 128-element group. */
float eliza_dot_q_turbo3(const float q[128], const eliza_block_turbo3_0 k[4]);
float eliza_dot_q_turbo4(const float q[128], const eliza_block_turbo4_0 k[4]);
float eliza_dot_q_turbo3_tcq(const float q[128], const eliza_block_turbo3_tcq * k);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_TURBO_KERNELS_REFERENCE_H */
