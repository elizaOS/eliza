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

/* The fused-attention reference reuses the fork-exact TBQ3 V-cache block +
 * decode from the turbo reference (block_tbq3_0 / eliza_tbq3_decode_block_uncond). */
#include "../reference/turbo_kernels.h"

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

/* ---------- Fused attention: GGML_OP_FUSED_ATTN_QJL_TBQ + Polar V variant ----------
 *
 * Single-source-of-truth C reference for the fused-attention shape the Metal /
 * Vulkan / CUDA agents must mirror. Bit-exact to fused_attn_qjl_tbq_ref in the
 * eliza-llama-cpp fork (ggml/src/ggml-cpu/fused-attn-qjl-tbq.c) for the TBQ
 * variant; the Polar variant swaps the V-cache decode for block_q4_polar and
 * is spec'd identically in reports/porting/2026-05-11/fused-attn-op-contract.md.
 *
 * Geometry (per head): head_dim = ELIZA_QJL_HEAD_DIM (128), proj_dim =
 * ELIZA_QJL_PROJECTION_DIM (256). GQA: hk = hq / (n_heads / n_kv_heads).
 *
 * Online (never-materialize-the-full-score-vector) softmax — the reference
 * walks K twice (pass 1: scores + running max; pass 1b/1c: exp + running
 * sum) and V once (pass 2: weighted V-mix into the output accumulator). GPU
 * ports SHOULD use the one-pass FlashAttention rescaling form; both are
 * numerically equivalent within tolerance and produce the same DTO.
 *
 * Q is the *pre-projected QJL query sketch*: proj_dim fp32 per head, already
 * Π·q. Set q_is_pre_projected accordingly in the manifest (always 1 today —
 * the surrounding graph computes the sketch once per Q). */

#define ELIZA_FUSED_HEAD_DIM   ELIZA_QJL_HEAD_DIM        /* 128 */
#define ELIZA_FUSED_PROJ_DIM   ELIZA_QJL_PROJECTION_DIM  /* 256 */
#define ELIZA_FUSED_TBQ_BLOCK  32
#define ELIZA_FUSED_TBQ_PER_TOKEN (ELIZA_FUSED_HEAD_DIM / ELIZA_FUSED_TBQ_BLOCK)  /* 4 */

/* TBQ3-V fused attention. Inputs:
 *   q_sketch    [proj_dim, n_heads]                fp32, Π·q per head
 *   packed_k    [head_dim, n_tokens, n_kv_heads]   block_qjl1_256 (34 B/token)
 *   packed_v    [head_dim, n_tokens, n_kv_heads]   block_tbq3_0 ×4/token (56 B/token)
 *   n_heads, n_kv_heads, n_tokens, sm_scale (pre-softmax temperature, e.g. 1/sqrt(head_dim))
 * Output:
 *   out         [head_dim, n_heads]                fp32
 */
void eliza_fused_attn_qjl_tbq3(const float * q_sketch,
                               const eliza_block_qjl1_256 * packed_k,
                               const eliza_block_tbq3_0 * packed_v,
                               int n_heads, int n_kv_heads, int n_tokens,
                               float sm_scale,
                               float * out);

/* Polar-V fused attention. Same K side; V is block_q4_polar (82 B/token, one
 * block per 128-element head row). use_qjl selects whether the Polar V-cache
 * carries its optional 1-bit residual. */
void eliza_fused_attn_qjl_polar(const float * q_sketch,
                                const eliza_block_qjl1_256 * packed_k,
                                const eliza_block_q4_polar * packed_v,
                                int n_heads, int n_kv_heads, int n_tokens,
                                float sm_scale, int use_qjl,
                                float * out);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_QJL_POLAR_REFERENCE_H */
