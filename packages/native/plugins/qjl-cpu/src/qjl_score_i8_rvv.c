/*
 * RISC-V Vector (RVV 1.0) GQA attention-score kernel for the
 * experimental int8 query sketch.
 *
 * Mirrors qjl_score_avxvnni.c (AVX-VNNI vpdpbusd) and
 * qjl_score_dotprod.c (ARMv8.4 sdot/udot). RVV 1.0 has no single-
 * instruction i8-dot — the upcoming Zvqdot extension would expose a
 * `vqdot.vv` primitive analogous to vpdpbusd, but no shipping silicon
 * implements it yet. We synthesize the dot via the widening sequence:
 *
 *     vint16m2_t prod = __riscv_vwmul_vv_i16m2(va_i8, vb_i8, vl);
 *     vint32m4_t acc  = __riscv_vwadd_wv_i32m4(acc, prod, vl);
 *
 * which compiles down to vwmul.vv (i8*i8 → i16) + vwadd.wv (i16 add
 * into i32 accumulator) — two-instruction microcode dot, executed as
 * a chained pair on the vector engine.
 *
 * Algebra: same as the AVX-VNNI path. With bits ∈ {0,1} and q ∈ i8,
 *
 *     raw = sum_j (2 * bit_j - 1) * q_j
 *         = 2 * sum_j (bit_j * q_j)  -  sum_j q_j
 *
 * The bit-expansion to {0,1} i8 is the same byte→8-lane idiom used by
 * the NEON dotprod path: broadcast each byte, mask against a lane-bit
 * weight {1,2,4,...,128}, compare equal → {0,1}. We expand 16 bits
 * (2 source bytes) per RVV strip when VLEN>=128 (vl>=16 at SEW=8 m1),
 * or more on wider VLEN.
 *
 * `sum_j q_j` is precomputed once per head against an all-ones u8
 * vector, same as the AVX-VNNI / dotprod variants.
 *
 * Zvqdot readiness: once the extension lands in shipping silicon, gate a
 * single `vqdot.vv` path behind a `has_zvqdot` bitfield in
 * qjl_cpu_features_t. The dispatcher should probe
 * RISCV_HWPROBE_EXT_ZVQDOTQ from riscv_hwprobe before selecting a
 * qjl_score_qk_i8_rvv_zvqdot variant.
 *
 * Reference: rvv-intrinsic-doc widening multiply-accumulate idioms,
 * https://github.com/riscv-non-isa/rvv-intrinsic-doc.
 */

#if defined(__riscv) && (__riscv_xlen == 64) && defined(__riscv_v_intrinsic)

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <riscv_vector.h>
#include <stdint.h>

/* Expand `nbytes` packed sign bytes from `src` into `nbytes*8` lanes of
 * {0,1} i8, starting at out[0]. Internal helper -- not exported.
 *
 * The scalar bit-expansion is fast enough at QJL's proj_dim=256 that
 * vectorizing it is not worth the intrinsic complexity. The token loop
 * is the hot path; bit expansion is at most 32 bytes = 256 ops per
 * token, dwarfed by the proj_dim*head_dim FMA work. The compiler is
 * free to vectorize this loop on its own. */
static inline void expand_bits_to_i8(const uint8_t *src, int nbytes, int8_t *out) {
    for (int b = 0; b < nbytes; ++b) {
        uint8_t v = src[b];
        out[b * 8 + 0] = (int8_t)((v >> 0) & 1);
        out[b * 8 + 1] = (int8_t)((v >> 1) & 1);
        out[b * 8 + 2] = (int8_t)((v >> 2) & 1);
        out[b * 8 + 3] = (int8_t)((v >> 3) & 1);
        out[b * 8 + 4] = (int8_t)((v >> 4) & 1);
        out[b * 8 + 5] = (int8_t)((v >> 5) & 1);
        out[b * 8 + 6] = (int8_t)((v >> 6) & 1);
        out[b * 8 + 7] = (int8_t)((v >> 7) & 1);
    }
}

/* i8 x i8 dot product over QJL_PROJECTION_DIM lanes. Returns int32 sum.
 * Strip-mines with SEW=8 LMUL=m1 for the loads, widens via vwmul +
 * vwadd into an i32 LMUL=m4 accumulator, reduces to scalar at the end. */
static inline int32_t rvv_i8_dot(const int8_t *a, const int8_t *b, int n) {
    size_t vlmax32 = __riscv_vsetvlmax_e32m4();
    vint32m4_t acc = __riscv_vmv_v_x_i32m4(0, vlmax32);
    int remaining = n;
    const int8_t *pa = a;
    const int8_t *pb = b;
    while (remaining > 0) {
        size_t vl = __riscv_vsetvl_e8m1(remaining);
        vint8m1_t va = __riscv_vle8_v_i8m1(pa, vl);
        vint8m1_t vb = __riscv_vle8_v_i8m1(pb, vl);
        vint16m2_t prod = __riscv_vwmul_vv_i16m2(va, vb, vl);
        /* Widen-add into the i32 accumulator. vwadd.wv treats the wider
         * source (i32 acc) as the accumulator and adds the narrower
         * (i16 prod) into it, sign-extending lane by lane. */
        acc = __riscv_vwadd_wv_i32m4(acc, prod, vl);
        pa += vl;
        pb += vl;
        remaining -= (int)vl;
    }
    vint32m1_t zero = __riscv_vmv_v_x_i32m1(0, 1);
    vint32m1_t sum = __riscv_vredsum_vs_i32m4_i32m1(acc, zero, vlmax32);
    return __riscv_vmv_x_s_i32m1_i32(sum);
}

void qjl_score_qk_i8_rvv(const qjl_i8_sketch_256 *q_sketch_i8,
                         const qjl_block_qjl1_256 *packed_k,
                         int n_heads, int n_kv_heads, int n_tokens,
                         float *scores) {
    const float scl_base = 1.2533141373155003f / (float)QJL_PROJECTION_DIM;
    const int gqa = n_heads / n_kv_heads;

    /* Per-token scratch: 256 i8 = 256 B, stack-resident. Holds the
     * expanded {0,1} bits for the current (head, token). */
    _Alignas(16) int8_t bits_i8[QJL_PROJECTION_DIM];
    /* All-ones u8 vector for the sum_j q_j precompute. {0,1} treated as
     * i8 stays non-negative, so a signed dot with +1 works for the bit
     * sum (which we do not need here -- sum_q is over the q values, not
     * the bits). Re-using rvv_i8_dot with an all-ones vector is fine. */
    _Alignas(16) int8_t ones_i8[QJL_PROJECTION_DIM];
    for (int j = 0; j < QJL_PROJECTION_DIM; ++j) ones_i8[j] = 1;

    for (int hq = 0; hq < n_heads; ++hq) {
        const int hk = hq / gqa;
        const qjl_i8_sketch_256 *qs = q_sketch_i8 + hq;

        /* sum_j q_j -- one i8 dot against an all-ones vector. */
        const int32_t sum_q = rvv_i8_dot(ones_i8, qs->values, QJL_PROJECTION_DIM);

        const qjl_block_qjl1_256 *blk_base = packed_k + (size_t)hk * n_tokens;
        const float qscale = qs->scale;
        float *out = scores + (size_t)hq * n_tokens;

        for (int t = 0; t < n_tokens; ++t) {
            expand_bits_to_i8(blk_base[t].qs, QJL_PACKED_BYTES, bits_i8);
            const int32_t dot_pos =
                rvv_i8_dot(bits_i8, qs->values, QJL_PROJECTION_DIM);
            const int32_t raw = 2 * dot_pos - sum_q;
            const float norm_k = qjl_bf16_to_fp32(blk_base[t].norm_bf16);
            out[t] = scl_base * norm_k * qscale * (float)raw;
        }
    }
}

#endif /* __riscv && __riscv_v_intrinsic */

/* Avoid ISO C "empty translation unit" pedantic diagnostics when RVV is undefined. */
typedef int qjl_score_i8_rvv_iso_c_empty_tu_marker;
