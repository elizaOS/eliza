/* tbq_encode_rvv.c - RVV 1.0 intrinsic TB3 / TB4 block encode.
 *
 * Bit-exact to tbq_block_ref.c::tbq_quantize_tbq{3,4}_block_ref:
 *
 *   1. sign-flip per TBQ_SIGNS_32 (precondition step 1)
 *   2. size-32 orthonormal Walsh-Hadamard (precondition step 2)
 *      with 1/sqrt(32) scale folded in at the end
 *   3. RMS  d = sqrt(sum(x_i^2) / 32)
 *   4. nearest-codebook index per element (TBQ3: 8 entries, TBQ4: 16)
 *
 * VL-agnostic. Built only on riscv64 with `-march=rv64gcv1p0`. All 32
 * floats live in a single LMUL=8 vector register group (vfloat32m8_t):
 * with the RVV minimum VLEN=128 that is exactly 32 f32 lanes, and for
 * larger VLEN the unused tail is masked off via the explicit vl=32
 * we pass to vsetvl. The Hadamard butterfly at each layer permutes
 * partners via `vrgather` and selects add/subtract via a per-lane mask.
 *
 * Codebook quantize: TBQ3 has 8 centroids, TBQ4 has 16. Both fit in a
 * single LMUL=1 group at any reasonable VLEN, so we hold the codebook
 * in a vector register and do a SIMD-parallel argmin across the small
 * centroid set via `vrgather`. Tie-breaking matches the scalar ref's
 * `<=` rule.
 */

#if defined(__riscv) && defined(__riscv_v_intrinsic)

#include "turboquant/turboquant.h"

#include <riscv_vector.h>
#include <math.h>
#include <string.h>
#include <stddef.h>

/* ---------- shared helpers ---------- *
 * The Hadamard partner at layer `len` for lane `i` is `i XOR len`. The
 * sign bit (whether we add or subtract that partner) is `(i & len) != 0`:
 * lower lanes in each pair get `a + b`, upper lanes get `a - b` where
 * `a` is the lower-index sibling and `b` is the upper-index sibling.
 *
 * The scalar form is:
 *     a = x[i & ~len]
 *     b = x[(i & ~len) | len]
 *     x[i & ~len] = a + b
 *     x[(i & ~len) | len] = a - b
 *
 * Per-lane vector form: for each i, the partner index `j = i ^ len`,
 * and `x_new[i] = (upper ? -1 : 1) * x[j] + x[i & ~len ?? ]`. The
 * cleanest expression: gather two halves and let the mask choose.
 *
 *   pair_lo_idx[i] = i & ~len   (the lower-index sibling for both i's of the pair)
 *   pair_hi_idx[i] = i |  len   (the upper-index sibling for both i's of the pair)
 *   is_upper[i]    = (i & len) != 0
 *
 *   lo = vrgather(x, pair_lo_idx)
 *   hi = vrgather(x, pair_hi_idx)
 *   x_new = is_upper ? (lo - hi) : (lo + hi)
 */

/* Build the 32-lane index vectors for one Hadamard layer at stride
 * `len` (one of 1, 2, 4, 8, 16). */
static inline void tbq_rvv_layer_indices(
    uint32_t len,
    uint32_t * out_lo, uint32_t * out_hi, uint8_t * out_mask)
{
    for (uint32_t i = 0; i < 32; ++i) {
        out_lo[i]   = i & ~len;
        out_hi[i]   = i | len;
        out_mask[i] = (i & len) ? 1 : 0;
    }
}

/* Apply size-32 orthonormal Walsh-Hadamard to `x` (32 lanes in m8).
 * Same butterfly schedule as the scalar reference, with the 1/sqrt(32)
 * normalisation folded in at the end. Returns the rotated vector. */
static inline vfloat32m8_t tbq_rvv_hadamard32(vfloat32m8_t x, size_t vl) {
    /* Layer stride doubles each iteration. */
    static const uint32_t kStrides[5] = { 1, 2, 4, 8, 16 };
    uint32_t lo_idx[32], hi_idx[32];
    uint8_t  upper[32];
    for (int layer = 0; layer < 5; ++layer) {
        const uint32_t len = kStrides[layer];
        tbq_rvv_layer_indices(len, lo_idx, hi_idx, upper);

        vuint32m8_t vlo_idx = __riscv_vle32_v_u32m8(lo_idx, vl);
        vuint32m8_t vhi_idx = __riscv_vle32_v_u32m8(hi_idx, vl);

        vfloat32m8_t lo = __riscv_vrgather_vv_f32m8(x, vlo_idx, vl);
        vfloat32m8_t hi = __riscv_vrgather_vv_f32m8(x, vhi_idx, vl);

        vfloat32m8_t sum  = __riscv_vfadd_vv_f32m8(lo, hi, vl);
        vfloat32m8_t diff = __riscv_vfsub_vv_f32m8(lo, hi, vl);

        /* Build a vbool4_t (m8 has SEW/LMUL = 32/8 -> EMUL=4 -> bool4). */
        vuint8m2_t mask_bytes = __riscv_vle8_v_u8m2(upper, vl);
        vbool4_t   mask       = __riscv_vmsne_vx_u8m2_b4(mask_bytes, 0, vl);

        x = __riscv_vmerge_vvm_f32m8(sum, diff, mask, vl);
    }
    /* 1 / sqrt(32) */
    const float norm = 0.1767766952966369f;
    x = __riscv_vfmul_vf_f32m8(x, norm, vl);
    return x;
}

/* Apply the canonical TBQ_SIGNS_32 mask in vector. */
static inline vfloat32m8_t tbq_rvv_apply_signs(const float * src, size_t vl) {
    float signs_f[32];
    for (int i = 0; i < 32; ++i) signs_f[i] = (float)TBQ_SIGNS_32[i];
    vfloat32m8_t x = __riscv_vle32_v_f32m8(src, vl);
    vfloat32m8_t s = __riscv_vle32_v_f32m8(signs_f, vl);
    return __riscv_vfmul_vv_f32m8(x, s, vl);
}

/* RMS = sqrt(sum(x_i^2) / 32). Scalar reduce after a SIMD square. */
static inline float tbq_rvv_rms(vfloat32m8_t x, size_t vl) {
    vfloat32m8_t sq = __riscv_vfmul_vv_f32m8(x, x, vl);
    vfloat32m1_t zero = __riscv_vfmv_v_f_f32m1(0.0f, 1);
    vfloat32m1_t acc  = __riscv_vfredusum_vs_f32m8_f32m1(sq, zero, vl);
    float sumsq = __riscv_vfmv_f_s_f32m1_f32(acc);
    return sqrtf(sumsq / (float)32);
}

/* fp32 -> fp16 helpers live in the scalar TU. */
extern uint16_t tbq_fp32_to_fp16(float f);

/* ---------- codebook-search via vrgather ----------
 *
 * Compute argmin_k |v - cb[k]| for a vector of scaled values `v`. The
 * codebook has N <= 16 sorted entries, so the result is at most
 * 4 bits / lane.
 *
 * Strategy: keep `v` in a 32-lane group, and for each codebook entry
 * k = 0..N-1 compute `|v - cb[k]|`. The running min and argmin are
 * tracked across the 32 lanes via vector compare + merge. This is the
 * literal scalar inner loop, parallelised across the 32 elements.
 *
 * Tie-break: scalar ref's `tbq_nearest` uses `<=` (prefer lower index
 * when distances are equal). We replicate that with a strict-less-than
 * compare so we only update argmin when a *strictly* smaller distance
 * is found, never on ties — which keeps the smallest codebook index
 * the winner. */
static inline vuint8m2_t tbq_rvv_argmin(
    vfloat32m8_t v, const float * cb, int n, size_t vl)
{
    /* Initialise best distance / best index from k=0. */
    float diff0 = 0.0f;
    (void)diff0;

    vfloat32m8_t cb0 = __riscv_vfmv_v_f_f32m8(cb[0], vl);
    vfloat32m8_t d0  = __riscv_vfsub_vv_f32m8(v, cb0, vl);
    vfloat32m8_t best_dist = __riscv_vfabs_v_f32m8(d0, vl);
    /* best_idx starts at 0 across all lanes. m2 of uint8 fits 32 entries
     * at VLEN >= 128 trivially. */
    vuint8m2_t best_idx = __riscv_vmv_v_x_u8m2(0, vl);

    for (int k = 1; k < n; ++k) {
        vfloat32m8_t cbk = __riscv_vfmv_v_f_f32m8(cb[k], vl);
        vfloat32m8_t dk  = __riscv_vfsub_vv_f32m8(v, cbk, vl);
        vfloat32m8_t adk = __riscv_vfabs_v_f32m8(dk, vl);
        /* Strict < ; ties keep the smaller-index winner. */
        vbool4_t lt = __riscv_vmflt_vv_f32m8_b4(adk, best_dist, vl);
        best_dist = __riscv_vmerge_vvm_f32m8(best_dist, adk, lt, vl);
        vuint8m2_t cand = __riscv_vmv_v_x_u8m2((uint8_t)k, vl);
        best_idx = __riscv_vmerge_vvm_u8m2(best_idx, cand, lt, vl);
    }
    /* Scalar ref's nearest also clamps to first/last centroid before
     * binary search; for sorted symmetric codebooks the linear-scan
     * argmin yields the same answer. */
    return best_idx;
}

/* ---------- pack 3-bit indices into the TBQ3 layout ----------
 *
 * Same wire format as tbq3_set() in the scalar ref: 3 bits per index,
 * LSB-first, packed across 12 bytes. The bit positions cross byte
 * boundaries every 3 lanes, so a SIMD pack is awkward; we run the pack
 * scalar after pulling the 32 codes out of the vector register. The
 * dominant cost is the 32 distance computations above, which is the
 * part we vectorise. */
static void tbq_rvv_pack3(const uint8_t codes[32], uint8_t qs[12]) {
    memset(qs, 0, 12);
    for (int idx = 0; idx < 32; ++idx) {
        const int bit = idx * 3;
        const int byte = bit >> 3;
        const int shift = bit & 7;
        qs[byte] = (uint8_t)(qs[byte] | ((codes[idx] & 0x7u) << shift));
        if (shift > 5 && byte + 1 < 12) {
            qs[byte + 1] = (uint8_t)(qs[byte + 1] | ((codes[idx] & 0x7u) >> (8 - shift)));
        }
    }
}

/* ---------- pack 4-bit indices into the TBQ4 layout ----------
 *
 * q4_0-style: low nibble of qs[j] holds index j, high nibble holds
 * index j + 16. */
static void tbq_rvv_pack4(const uint8_t codes[32], uint8_t qs[16]) {
    for (int j = 0; j < 16; ++j) {
        qs[j] = (uint8_t)((codes[j] & 0x0Fu) | ((codes[j + 16] & 0x0Fu) << 4));
    }
}

/* ---------- public encode entry points ---------- */

void tbq_quantize_tbq3_block_rvv(const float src[32], tbq_block_tbq3_0 * dst) {
    const size_t vl = __riscv_vsetvl_e32m8(32);
    vfloat32m8_t signed_x = tbq_rvv_apply_signs(src, vl);
    vfloat32m8_t rot      = tbq_rvv_hadamard32(signed_x, vl);
    const float d = tbq_rvv_rms(rot, vl);

    dst->d = tbq_fp32_to_fp16(d);
    memset(dst->qs, 0, sizeof(dst->qs));
    if (d == 0.0f) return;

    const float id = 1.0f / d;
    vfloat32m8_t scaled = __riscv_vfmul_vf_f32m8(rot, id, vl);
    vuint8m2_t   codes  = tbq_rvv_argmin(scaled, TBQ3_CODEBOOK, 8, vl);

    uint8_t code_buf[32];
    __riscv_vse8_v_u8m2(code_buf, codes, vl);
    tbq_rvv_pack3(code_buf, dst->qs);
}

void tbq_quantize_tbq4_block_rvv(const float src[32], tbq_block_tbq4_0 * dst) {
    const size_t vl = __riscv_vsetvl_e32m8(32);
    vfloat32m8_t signed_x = tbq_rvv_apply_signs(src, vl);
    vfloat32m8_t rot      = tbq_rvv_hadamard32(signed_x, vl);
    const float d = tbq_rvv_rms(rot, vl);

    dst->d = tbq_fp32_to_fp16(d);
    memset(dst->qs, 0, sizeof(dst->qs));
    if (d == 0.0f) return;

    const float id = 1.0f / d;
    vfloat32m8_t scaled = __riscv_vfmul_vf_f32m8(rot, id, vl);
    vuint8m2_t   codes  = tbq_rvv_argmin(scaled, TBQ4_CODEBOOK, 16, vl);

    uint8_t code_buf[32];
    __riscv_vse8_v_u8m2(code_buf, codes, vl);
    tbq_rvv_pack4(code_buf, dst->qs);
}

#endif /* __riscv && __riscv_v_intrinsic */
