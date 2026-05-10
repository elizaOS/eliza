/* DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
 *
 * Reference C declarations for QJL and PolarQuant fixture generation.
 * Mirror the bit-exact CPU references that live under
 *   packages/native-plugins/qjl-cpu/src/qjl_score_ref.c
 *   packages/native-plugins/polarquant-cpu/src/polar_dequantize_ref.c
 *   packages/native-plugins/polarquant-cpu/src/polar_dot_ref.c
 *   packages/native-plugins/polarquant-cpu/src/polar_qjl.c
 *   packages/native-plugins/polarquant-cpu/src/polar_hadamard.c
 * Re-implemented here so the verify/ harness has zero deps on those plugin
 * checkouts (which live in a separate package and are owned by W1-A / W1-B).
 *
 * Block layouts (must match the on-fork ggml-common.h additions):
 *   block_qjl1_256    : 34 bytes (qs[32] sign bits + bf16 norm)
 *   block_q4_polar    : 82 bytes packed (fp16 d + qs[64] + qjl[16])
 */

#ifndef ELIZA_QJL_POLAR_REFERENCE_H
#define ELIZA_QJL_POLAR_REFERENCE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------- QJL ---------- */

#define ELIZA_QJL_HEAD_DIM        128
#define ELIZA_QJL_PROJECTION_DIM  256
#define ELIZA_QJL_PACKED_BYTES    (ELIZA_QJL_PROJECTION_DIM / 8)   /* 32 */

typedef struct {
    uint8_t  qs[ELIZA_QJL_PACKED_BYTES]; /* 256 sign bits, LSB = bit 0 of byte 0 */
    uint16_t norm_bf16;                  /* bf16 of ||k||_2 */
} eliza_block_qjl1_256;                  /* 34 bytes */

uint16_t eliza_fp32_to_bf16(float f);
float    eliza_bf16_to_fp32(uint16_t b);

/* Generate a deterministic JL projection matrix Π (head_dim, proj_dim)
 * row-major from a seed. Box-Muller on a Mersenne-Twister-like stream so the
 * fixtures are reproducible across hosts. NOT bit-identical to torch.randn.
 */
void eliza_qjl_make_projection(float * prj, uint64_t seed);

/* Quantize one key row (head_dim floats) into one block. Matches the
 * inlier-only CPU reference in qjl_quantize_row_ref. */
void eliza_qjl_quantize_row(const float * key, const float * prj,
                            eliza_block_qjl1_256 * out);

/* Project Q -> sketch (head_dim -> proj_dim). Used so fixtures can store the
 * pre-projected sketch the score kernel actually consumes. */
void eliza_qjl_sketch_query(const float * q_row, const float * prj,
                            float * q_sketch);

/* GQA attention score, bit-identical to qjl_score_qk_ref. */
void eliza_qjl_score_qk(const float * q_sketch,
                        const eliza_block_qjl1_256 * packed_k,
                        int n_heads, int n_kv_heads, int n_tokens,
                        float * scores);

/* Single-block matrix-vector multiply (kernel_mul_mv_qjl1_256_f32 reference):
 * y[r] = ||k_r|| * sqrt(pi/2)/proj_dim * sum_j sign_packed[r,j] * q[j]. */
void eliza_qjl_mul_mv(const eliza_block_qjl1_256 * k_blocks,
                      const float * q_sketch,
                      int n_rows,
                      float * y);

/* Single-block dequantize (kernel_get_rows_qjl1_256 reference):
 * out[i] = (||k|| * sqrt(pi/2) / proj_dim) * sum_j sign_packed[j] * prj[i*proj_dim + j]. */
void eliza_qjl_dequantize_row(const eliza_block_qjl1_256 * blk,
                              const float * prj, float * out);

/* ---------- PolarQuant ---------- */

#define ELIZA_QK_POLAR              128
#define ELIZA_QJL_RESIDUAL_BYTES    (ELIZA_QK_POLAR / 8)
#define ELIZA_POLAR_QJL_SEED        42
#define ELIZA_POLAR_QJL_MAGNITUDE   0.5f

#if defined(_MSC_VER)
#pragma pack(push, 1)
typedef struct {
    uint16_t d;                                /* fp16 per-block L2 norm */
    uint8_t  qs[ELIZA_QK_POLAR / 2];           /* 4-bit codes, 2 per byte */
    uint8_t  qjl[ELIZA_QJL_RESIDUAL_BYTES];    /* optional 1-bit QJL residual */
} eliza_block_q4_polar;
#pragma pack(pop)
#else
typedef struct __attribute__((packed)) {
    uint16_t d;
    uint8_t  qs[ELIZA_QK_POLAR / 2];
    uint8_t  qjl[ELIZA_QJL_RESIDUAL_BYTES];
} eliza_block_q4_polar;                        /* 82 bytes */
#endif

extern const float ELIZA_POLAR_Q4_CENTROIDS[16];
extern const float ELIZA_POLAR_Q4_BOUNDARIES[15];

/* In-place 128-element Walsh-Hadamard butterfly (matches polar_hadamard_inplace). */
void eliza_polar_hadamard_inplace(float * x);

/* Deterministic per-block ±1 sign vector (matches polar_qjl_signs xorshift32). */
void eliza_polar_qjl_signs(float * out);

/* Encode k floats (k = N * QK_POLAR) into N consecutive blocks. */
void eliza_polar_quantize_row(const float * x, eliza_block_q4_polar * y,
                              int64_t k, int use_qjl);

/* Decode k floats from N consecutive blocks. Bit-identical to
 * dequantize_row_q4_polar_ref. */
void eliza_polar_dequantize_row(const eliza_block_q4_polar * x, float * y,
                                int64_t k, int use_qjl);

/* Single-block dot product against an fp32 query
 * (kernel_mul_mv_q4_polar_f32 reference path; n must equal QK_POLAR).
 * y[row] = <dequant(K_blocks[row]), q[QK_POLAR]>. */
void eliza_polar_mul_mv(const eliza_block_q4_polar * k_blocks,
                        const float * q,
                        int n_rows, int use_qjl,
                        float * y);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_QJL_POLAR_REFERENCE_H */
