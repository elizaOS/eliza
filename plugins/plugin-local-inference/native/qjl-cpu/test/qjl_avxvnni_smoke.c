/*
 * Parity smoke for the runtime-dispatched int8-sketch QJL score path
 * (AVX-VNNI on x86, dot-product on ARM, scalar elsewhere) against the
 * scalar reference qjl_score_qk_i8_ref. The integer sign-dot is exact,
 * so the two results must match bit-for-bit (only the fp32 scale
 * multiply at the end can differ, and it is the same multiply in both).
 */
#include "qjl/qjl.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>

static uint32_t xs(uint32_t *s) {
    uint32_t x = *s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return *s = x;
}
static float unit(uint32_t *s) { return ((float)(int32_t)xs(s)) / 2147483648.0f; }

int main(void) {
    enum { N_HEADS = 12, N_KV_HEADS = 3, N_TOKENS = 257 };
    static float q_sketch[N_HEADS * QJL_PROJECTION_DIM];
    static qjl_block_qjl1_256 packed[N_KV_HEADS * N_TOKENS];
    static qjl_i8_sketch_256 q_i8[N_HEADS];
    static float ref[N_HEADS * N_TOKENS];
    static float got[N_HEADS * N_TOKENS];

    uint32_t s = 0xC0FFEEu;
    for (int i = 0; i < N_HEADS * QJL_PROJECTION_DIM; ++i) q_sketch[i] = 0.9f * unit(&s);
    for (int i = 0; i < N_KV_HEADS * N_TOKENS; ++i) {
        for (int b = 0; b < QJL_PACKED_BYTES; ++b) packed[i].qs[b] = (uint8_t)(xs(&s) & 0xFFu);
        packed[i].norm_bf16 = qjl_fp32_to_bf16(0.25f + 4.0f * fabsf(unit(&s)));
    }

    qjl_quantize_sketch_i8_ref(q_sketch, q_i8, N_HEADS);
    qjl_score_qk_i8_ref(q_i8, packed, N_HEADS, N_KV_HEADS, N_TOKENS, ref);
    qjl_score_qk_i8(q_i8, packed, N_HEADS, N_KV_HEADS, N_TOKENS, got);

    int fail = 0;
    float max_abs = 0.0f;
    for (int i = 0; i < N_HEADS * N_TOKENS; ++i) {
        float d = fabsf(ref[i] - got[i]);
        if (d > max_abs) max_abs = d;
        /* bit-exact integer dot; allow only the tiny fp32 mul rounding. */
        float tol = 1e-4f * fmaxf(1.0f, fabsf(ref[i]));
        if (d > tol) { if (fail < 5) fprintf(stderr, "i=%d ref=%+.7f got=%+.7f d=%.3e\n", i, ref[i], got[i], d); ++fail; }
    }
    printf("[qjl-avxvnni-smoke] active=%s max_abs=%.3e failures=%d\n",
           qjl_active_simd(), max_abs, fail);
    return fail == 0 ? 0 : 1;
}
