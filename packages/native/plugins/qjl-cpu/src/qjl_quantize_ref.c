/*
 * Scalar reference for QJL quantize / dequantize.
 * Always built. Defines correctness; the SIMD paths must agree with it.
 *
 * Mirrors `qjl_pure_pytorch_quantize` in
 * packages/training/scripts/quantization/test_qjl.py:
 *   sketch = key @ prj                # (head_dim,) @ (head_dim, proj_dim) -> (proj_dim,)
 *   bits   = (sketch > 0).uint8       # LSB-first packing within a byte
 *   norm   = bf16(||key||_2)
 */

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <math.h>
#include <string.h>

void qjl_quantize_row_ref(const float *key, const float *prj,
                          qjl_block_qjl1_256 *out) {
    /* ||key|| in fp32, then bf16-round at the end. */
    float norm_sq = 0.0f;
    for (int i = 0; i < QJL_HEAD_DIM; i++) {
        norm_sq += key[i] * key[i];
    }
    out->norm_bf16 = qjl_fp32_to_bf16(sqrtf(norm_sq));

    /* sketch[j] = sum_i key[i] * prj[i*proj_dim + j] */
    /* Pack 8 bits LSB-first. */
    memset(out->qs, 0, QJL_PACKED_BYTES);
    for (int j = 0; j < QJL_PROJECTION_DIM; j++) {
        float acc = 0.0f;
        for (int i = 0; i < QJL_HEAD_DIM; i++) {
            acc += key[i] * prj[i * QJL_PROJECTION_DIM + j];
        }
        if (acc > 0.0f) {
            out->qs[j >> 3] |= (uint8_t)(1u << (j & 7));
        }
    }
}

void qjl_quantize_rows_ref(const float *keys, const float *prj,
                           qjl_block_qjl1_256 *out, size_t n_rows) {
    for (size_t r = 0; r < n_rows; r++) {
        qjl_quantize_row_ref(keys + r * QJL_HEAD_DIM, prj, out + r);
    }
}

/*
 * Dequantize: reconstruct an fp32 approximation of the original key.
 * Uses the same scl = sqrt(pi/2) / proj_dim factor as the score kernel.
 */
void qjl_dequantize_row_ref(const qjl_block_qjl1_256 *blk, const float *prj,
                            float *out) {
    /* sqrt(pi/2) ≈ 1.2533141373155003f. Matches the score kernel's `scl`. */
    const float scl = 1.2533141373155003f / (float)QJL_PROJECTION_DIM
                      * qjl_bf16_to_fp32(blk->norm_bf16);
    for (int i = 0; i < QJL_HEAD_DIM; i++) {
        float acc = 0.0f;
        const float *row = prj + i * QJL_PROJECTION_DIM;
        for (int j = 0; j < QJL_PROJECTION_DIM; j++) {
            int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
            acc += (bit ? row[j] : -row[j]);
        }
        out[i] = scl * acc;
    }
}
