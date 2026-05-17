/*
 * Scalar reference for the GQA attention-score path.
 *
 * The pre-projected query sketch (shape: n_heads * proj_dim) is supplied
 * by the caller — caching that sketch across the decode steps is the
 * whole point of QJL on the K side. Each output score is:
 *
 *   score[h_q, t] = ||k_t|| * sqrt(pi/2)/proj_dim *
 *                   sum_j sign_packed[t, j] * q_sketch[h_q, j]
 *
 * with sign_packed[t, j] = +1 if bit j of token t's packed signs is set,
 * -1 otherwise. h_kv = h_q / (n_heads / n_kv_heads) for GQA sharing.
 */

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <math.h>

void qjl_score_qk_ref(const float *q_sketch,
                      const qjl_block_qjl1_256 *packed_k,
                      int n_heads, int n_kv_heads, int n_tokens,
                      float *scores) {
    /* sqrt(pi/2) / proj_dim — matches CUDA score kernel line 175. */
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads; /* >= 1 */

    for (int hq = 0; hq < n_heads; hq++) {
        int hk = hq / gqa;
        const float *qs = q_sketch + hq * QJL_PROJECTION_DIM;

        for (int t = 0; t < n_tokens; t++) {
            const qjl_block_qjl1_256 *blk = packed_k + hk * n_tokens + t;
            float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            float acc = 0.0f;
            for (int j = 0; j < QJL_PROJECTION_DIM; j++) {
                int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
                acc += (bit ? qs[j] : -qs[j]);
            }
            scores[hq * n_tokens + t] = scl_base * norm_k * acc;
        }
    }
}
