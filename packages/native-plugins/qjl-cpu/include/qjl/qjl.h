/*
 * QJL 1-bit JL Transform K-cache compression — public API.
 *
 * Reference: Zandieh, Daliri, Han. "QJL: 1-Bit Quantized JL Transform
 * for KV Cache Quantization with Zero Overhead", AAAI 2025
 * (arXiv:2406.03482). The original CUDA reference lives at
 *   packages/training/scripts/quantization/qjl/csrc/qjl_quant_kernel.cu
 *   packages/training/scripts/quantization/qjl/csrc/qjl_gqa_score_kernel.cu
 * and the pure-PyTorch reference at
 *   packages/training/scripts/quantization/test_qjl.py
 * This library implements the inlier-only branch (no outlier sketch),
 * which is the form that ships through the CPU KV-cache path.
 *
 * Canonical paper defaults that this library is dimensioned around:
 *   head_dim                   = 128
 *   projection_dim_per_head    = 256
 *   projection_seed            = 42
 *
 * Block layout (`block_qjl1_256`): 32 bytes packed signs + bf16 norm = 34 B.
 * Compression ratio at head_dim=128: 128 * 2 / 34 = 7.53x vs bf16 K-cache.
 */

#ifndef QJL_QJL_H
#define QJL_QJL_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Canonical paper defaults. */
#define QJL_HEAD_DIM            128
#define QJL_PROJECTION_DIM      256
#define QJL_PACKED_BYTES        (QJL_PROJECTION_DIM / 8)   /* 32 */
#define QJL_BLOCK_BYTES         (QJL_PACKED_BYTES + 2)     /* 34 */

/* On-disk / on-cache block layout for one cached key vector. */
typedef struct {
    uint8_t  qs[QJL_PACKED_BYTES]; /* 256 sign bits, LSB = bit 0 of byte 0 */
    uint16_t norm_bf16;            /* bf16 L2 norm of the original key */
} qjl_block_qjl1_256;

/*
 * Build a JL projection matrix Π in row-major (head_dim, projection_dim)
 * layout, deterministic from `seed`. The standalone reference uses an
 * external matrix supplied by the caller (see `qjl_quantize_row_*`); this
 * helper exists for hosts that want to derive Π from a seed alone, using
 * a Box-Muller draw on top of a Mersenne-Twister-derived stream. Note
 * that PyTorch's torch.randn is a different draw — fixtures generated
 * from PyTorch will ship the projection matrix explicitly.
 *
 * Returns 0 on success.
 */
int qjl_make_projection_mt(float *prj, int head_dim, int proj_dim, uint64_t seed);

/* ---------------- quantize ---------------- */

/*
 * Quantize one key row (head_dim floats) into one block_qjl1_256 block.
 * `prj` is (head_dim, proj_dim) row-major. `proj_dim` must equal
 * QJL_PROJECTION_DIM; `head_dim` must equal QJL_HEAD_DIM.
 *
 * Algorithm (matches `qjl_pure_pytorch_quantize`):
 *   sketch[j] = sum_i key[i] * prj[i*proj_dim + j]
 *   bit[j]    = sketch[j] > 0 ? 1 : 0
 *   pack 8 bits LSB-first into qs[j/8]
 *   norm      = bf16(||key||_2)
 */
void qjl_quantize_row_ref(const float *key, const float *prj,
                          qjl_block_qjl1_256 *out);
void qjl_quantize_row_avx2(const float *key, const float *prj,
                           qjl_block_qjl1_256 *out);
void qjl_quantize_row_neon(const float *key, const float *prj,
                           qjl_block_qjl1_256 *out);

/* Bulk: quantize n_rows successive key vectors. Each row is head_dim floats. */
void qjl_quantize_rows_ref(const float *keys, const float *prj,
                           qjl_block_qjl1_256 *out, size_t n_rows);
void qjl_quantize_rows_avx2(const float *keys, const float *prj,
                            qjl_block_qjl1_256 *out, size_t n_rows);
void qjl_quantize_rows_neon(const float *keys, const float *prj,
                            qjl_block_qjl1_256 *out, size_t n_rows);

/* Best available implementation on the running CPU. */
void qjl_quantize_rows(const float *keys, const float *prj,
                       qjl_block_qjl1_256 *out, size_t n_rows);

/* ---------------- dequantize ---------------- */

/*
 * Reconstruct an approximate key row from a packed block.
 *
 * The QJL paper's recovery is asymmetric: the proper attention path is
 * reconstruct ||k|| * Π^T · sign(s) inside the score kernel; calling
 * this directly produces a cosine-similarity reconstruction useful for
 * debugging and dequant-then-fp32 fallback paths. Specifically:
 *
 *   recon[i] = (||k|| * sqrt(pi/2) / proj_dim) *
 *              sum_j sign_packed[j] * prj[i*proj_dim + j]
 *
 * where sign_packed[j] is +1 if bit j is set, -1 otherwise. The
 * sqrt(pi/2)/proj_dim scale matches the GQA score kernel (see
 * qjl_gqa_score_kernel.cu line 175: `scl = sqrtf(M_PI_2) / sketch_dim`).
 */
void qjl_dequantize_row_ref(const qjl_block_qjl1_256 *blk, const float *prj,
                            float *out);
void qjl_dequantize_row_avx2(const qjl_block_qjl1_256 *blk, const float *prj,
                             float *out);
void qjl_dequantize_row_neon(const qjl_block_qjl1_256 *blk, const float *prj,
                             float *out);

/* ---------------- GQA attention score ---------------- */

/*
 * GQA attention score: given a Q vector (n_heads heads of head_dim
 * floats) and a packed K cache (n_kv_heads, n_tokens, block_qjl1_256),
 * emit a score per (q_head, token) pair.
 *
 * Q is re-projected through the same Π once (`q_sketch`, supplied by
 * the caller — caching this is the whole point of QJL). The score is:
 *
 *   score[h_q, t] = ||k_t|| * sqrt(pi/2)/proj_dim *
 *                   sum_j sign_packed[t,j] * q_sketch[h_q, j]
 *
 * Here `h_q` maps to `h_kv = h_q / (n_heads/n_kv_heads)` for the
 * GQA share. Output shape: (n_heads, n_tokens) row-major.
 */
void qjl_score_qk_ref(const float *q_sketch,
                      const qjl_block_qjl1_256 *packed_k,
                      int n_heads, int n_kv_heads, int n_tokens,
                      float *scores);
void qjl_score_qk_avx2(const float *q_sketch,
                       const qjl_block_qjl1_256 *packed_k,
                       int n_heads, int n_kv_heads, int n_tokens,
                       float *scores);
void qjl_score_qk_neon(const float *q_sketch,
                       const qjl_block_qjl1_256 *packed_k,
                       int n_heads, int n_kv_heads, int n_tokens,
                       float *scores);

void qjl_score_qk(const float *q_sketch,
                  const qjl_block_qjl1_256 *packed_k,
                  int n_heads, int n_kv_heads, int n_tokens,
                  float *scores);

/* ---------------- helpers ---------------- */

/* IEEE float32 -> bfloat16 with round-to-nearest-even. */
uint16_t qjl_fp32_to_bf16(float x);
/* bfloat16 -> float32 zero-extension. */
float    qjl_bf16_to_fp32(uint16_t b);

/* Capability strings ("avx2" / "neon" / "ref") of the active SIMD path. */
const char *qjl_active_simd(void);

#ifdef __cplusplus
}
#endif

#endif /* QJL_QJL_H */
