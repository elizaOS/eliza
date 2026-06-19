/*
 * Experimental int8 query-sketch scoring path for QJL.
 *
 * This keeps the packed K-cache format unchanged. Only q_sketch is quantized
 * per query head to int8 + one fp32 scale, so the inner score becomes an
 * integer sign-dot followed by the usual QJL scale and the per-query scale.
 */

#include "qjl/qjl.h"
#include "qjl_block.h"

#include <math.h>
#include <stdint.h>

static int8_t clamp_i8(int v) {
    if (v > 127) return 127;
    if (v < -127) return -127;
    return (int8_t)v;
}

void qjl_quantize_sketch_i8_ref(const float *q_sketch,
                                qjl_i8_sketch_256 *out,
                                int n_heads) {
    for (int h = 0; h < n_heads; ++h) {
        const float *src = q_sketch + h * QJL_PROJECTION_DIM;
        qjl_i8_sketch_256 *dst = out + h;
        float max_abs = 0.0f;
        for (int j = 0; j < QJL_PROJECTION_DIM; ++j) {
            float a = fabsf(src[j]);
            if (a > max_abs) max_abs = a;
        }
        dst->scale = max_abs > 0.0f ? max_abs / 127.0f : 1.0f;
        const float inv = 1.0f / dst->scale;
        for (int j = 0; j < QJL_PROJECTION_DIM; ++j) {
            dst->values[j] = clamp_i8((int)lrintf(src[j] * inv));
        }
    }
}

void qjl_score_qk_i8_ref(const qjl_i8_sketch_256 *q_sketch_i8,
                         const qjl_block_qjl1_256 *packed_k,
                         int n_heads, int n_kv_heads, int n_tokens,
                         float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;

    for (int hq = 0; hq < n_heads; ++hq) {
        int hk = hq / gqa;
        const qjl_i8_sketch_256 *qs = q_sketch_i8 + hq;

        for (int t = 0; t < n_tokens; ++t) {
            const qjl_block_qjl1_256 *blk = packed_k + hk * n_tokens + t;
            int32_t acc = 0;
            for (int j = 0; j < QJL_PROJECTION_DIM; ++j) {
                int bit = (blk->qs[j >> 3] >> (j & 7)) & 1;
                int v = (int)qs->values[j];
                acc += bit ? v : -v;
            }
            float norm_k = qjl_bf16_to_fp32(blk->norm_bf16);
            scores[hq * n_tokens + t] = scl_base * norm_k * qs->scale * (float)acc;
        }
    }
}
