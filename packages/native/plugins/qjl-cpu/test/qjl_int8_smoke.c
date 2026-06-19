#include "qjl/qjl.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static uint32_t xorshift32(uint32_t *s) {
    uint32_t x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    return x;
}

static float rand_unit(uint32_t *s) {
    uint32_t x = xorshift32(s);
    return ((float)(int32_t)x) / 2147483648.0f;
}

int main(void) {
    enum { N_HEADS = 8, N_KV_HEADS = 2, N_TOKENS = 64 };
    float q_sketch[N_HEADS * QJL_PROJECTION_DIM];
    qjl_block_qjl1_256 packed[N_KV_HEADS * N_TOKENS];
    qjl_i8_sketch_256 q_i8[N_HEADS];
    float exact[N_HEADS * N_TOKENS];
    float approx[N_HEADS * N_TOKENS];

    uint32_t s = 42u;
    for (int i = 0; i < N_HEADS * QJL_PROJECTION_DIM; ++i) {
        q_sketch[i] = 0.75f * rand_unit(&s);
    }
    for (int i = 0; i < N_KV_HEADS * N_TOKENS; ++i) {
        for (int b = 0; b < QJL_PACKED_BYTES; ++b) {
            packed[i].qs[b] = (uint8_t)(xorshift32(&s) & 0xFFu);
        }
        float norm = 0.25f + 3.0f * fabsf(rand_unit(&s));
        packed[i].norm_bf16 = qjl_fp32_to_bf16(norm);
    }

    qjl_score_qk_ref(q_sketch, packed, N_HEADS, N_KV_HEADS, N_TOKENS, exact);
    qjl_quantize_sketch_i8_ref(q_sketch, q_i8, N_HEADS);
    qjl_score_qk_i8_ref(q_i8, packed, N_HEADS, N_KV_HEADS, N_TOKENS, approx);

    float max_rel = 0.0f;
    float max_abs = 0.0f;
    int fail = 0;
    for (int i = 0; i < N_HEADS * N_TOKENS; ++i) {
        float abs_diff = fabsf(exact[i] - approx[i]);
        float denom = fmaxf(1.0f, fabsf(exact[i]));
        float rel = abs_diff / denom;
        if (rel > max_rel) max_rel = rel;
        if (abs_diff > max_abs) max_abs = abs_diff;
        if (rel > 0.035f && abs_diff > 0.025f) {
            if (fail < 5) {
                fprintf(stderr, "score[%d] exact=%+.6f approx=%+.6f abs=%.6f rel=%.6f\n",
                        i, exact[i], approx[i], abs_diff, rel);
            }
            ++fail;
        }
    }

    float zeros[QJL_PROJECTION_DIM] = {0};
    qjl_i8_sketch_256 zq;
    qjl_quantize_sketch_i8_ref(zeros, &zq, 1);
    for (int j = 0; j < QJL_PROJECTION_DIM; ++j) {
        if (zq.values[j] != 0) {
            fprintf(stderr, "zero sketch quantized to nonzero at %d\n", j);
            ++fail;
            break;
        }
    }

    printf("[qjl-int8-smoke] max_abs=%.6f max_rel=%.6f failures=%d\n",
           max_abs, max_rel, fail);
    return fail == 0 ? 0 : 1;
}
