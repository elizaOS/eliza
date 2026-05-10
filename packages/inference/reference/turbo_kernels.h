/* DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
 *
 * Reference C declarations for turbo3 / turbo4 / turbo3_tcq KV cache
 * quantization, mirroring buun-llama-cpp's CPU reference at
 * ggml/src/ggml-turbo-quant.c (commit 6575873e9c4872709d374d854b583cfaa270caff).
 *
 * The block layouts follow ggml-common.h exactly:
 *   block_turbo3_0    : 14 bytes (norm fp16, qs[8], signs[4]),     QK=32
 *   block_turbo4_0    : 66 bytes (norm fp16, qs[64]),               QK=128
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
#define ELIZA_QK_TURBO4     128
#define ELIZA_QK_TURBO3_TCQ 128

typedef struct {
    uint16_t norm;            /* fp16 storage as raw uint16_t bits */
    uint8_t  qs[8];           /* QK_TURBO3/4: 4 indices per byte (low 2 bits) */
    uint8_t  signs[4];        /* QK_TURBO3/8: 1 sign-bit per element (3rd bit of 3-bit index) */
} eliza_block_turbo3_0;       /* 14 bytes */

typedef struct {
    uint16_t norm;            /* fp16 */
    uint8_t  qs[64];          /* QK_TURBO4/2: 4-bit indices, 2 per byte (low nibble first) */
} eliza_block_turbo4_0;       /* 66 bytes */

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

void eliza_quantize_turbo4_block(const float src[128], eliza_block_turbo4_0 * dst);
void eliza_dequantize_turbo4_block(const eliza_block_turbo4_0 * src, float dst[128]);

/* turbo3_tcq: full Viterbi encoder is O(128 * 512). Provided here for fixture
 * generation — slow, but correct relative to the CUDA Viterbi pass. */
void eliza_quantize_turbo3_tcq_block(const float src[128], eliza_block_turbo3_tcq * dst);
void eliza_dequantize_turbo3_tcq_block(const eliza_block_turbo3_tcq * src, float dst[128]);

/* Q · K dequantized dot product helpers (used by verification harness). Q is
 * fp32 length 128; the K block is one quantized 128-element group. */
float eliza_dot_q_turbo3(const float q[128], const eliza_block_turbo3_0 k[4]);
float eliza_dot_q_turbo4(const float q[128], const eliza_block_turbo4_0 * k);
float eliza_dot_q_turbo3_tcq(const float q[128], const eliza_block_turbo3_tcq * k);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_TURBO_KERNELS_REFERENCE_H */
