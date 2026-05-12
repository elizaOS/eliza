// HARDWARE VERIFIED on Apple M4 Max (Metal runtime JIT): 8/8 PASS against the
// fixture harness. Source-level verified against the PolarQuant CPU reference at
// packages/native-plugins/polarquant-cpu/src/polar_dequantize_ref.c and
// polar_dot_ref.c (W1-B's authoritative CPU side). The block layout
// (`block_q4_polar`), centroid LUT (POLAR_Q4_CENTROIDS), QJL residual
// magnitude (POLAR_QJL_CORRECTION_MAGNITUDE / sqrt(QK_POLAR)), and the
// (1 / QK_POLAR) compensation that turns the in-place Hadamard butterfly
// into the orthonormal inverse are all bit-identical.
//
// Block layout (block_q4_polar in polar_block.h, 82 bytes, packed):
//     fp16     d                          // [0..1]   per-block L2 norm
//     uchar    qs[QK_POLAR/2 = 64]        // [2..65]  4-bit codes, low nibble first
//     uchar    qjl[QJL_RESIDUAL_BYTES = 16] // [66..81] optional 1-bit QJL residual
//
// Total: 82 bytes per 128-element block.
//   With residual:    82*8 / 128 = 5.125 bpw
//   Without residual: 66*8 / 128 = 4.125 bpw  (qjl[] left at zero)
//
// Three kernels:
//   - kernel_get_rows_q4_polar     : decode one 128-element block to fp32
//                                    (LUT lookup + optional QJL residual + inverse
//                                    Hadamard + per-block L2 rescale).
//   - kernel_mul_mv_q4_polar_f32   : dot-product against an fp32 activation
//                                    chunk (n must be a positive multiple of
//                                    QK_POLAR; one threadgroup per block).
//   - kernel_mul_mv_q4_polar_preht_f32:
//                                    hot path for attention-score dispatches
//                                    that can pass H*q; avoids the per-row
//                                    Hadamard butterfly by using
//                                    dot(H*x, q) == dot(x, H*q).

#include <metal_stdlib>
using namespace metal;

#define QK_POLAR              128
#define QJL_RESIDUAL_BYTES    (QK_POLAR / 8)
#define POLAR_Q4_N_LEVELS     16

// Match POLAR_QJL_CORRECTION_MAGNITUDE in polarquant.h.
constant float POLAR_QJL_CORRECTION_MAGNITUDE = 0.5f;
// Magnitude divisor sqrt(QK_POLAR) = sqrt(128) = 11.313708498984761.
constant float POLAR_QJL_INV_SQRT_QK = 0.08838834764831845f; // 1/sqrt(128)
constant float POLAR_INV_QK = 1.0f / float(QK_POLAR);        // (1 / QK_POLAR) Hadamard compensation

// Bit-identical to POLAR_Q4_CENTROIDS in
// packages/native-plugins/polarquant-cpu/include/polarquant/polar_centroids.h.
constant float POLAR_Q4_CENTROIDS[POLAR_Q4_N_LEVELS] = {
    -2.754354807f, -2.093562707f, -1.643041510f, -1.279739752f,
    -0.962640978f, -0.672392117f, -0.397897103f, -0.131757782f,
     0.131757782f,  0.397897103f,  0.672392117f,  0.962640978f,
     1.279739752f,  1.643041510f,  2.093562707f,  2.754354807f,
};

// xorshift32(seed=42) sign vector used by the optional Polar QJL residual.
// Keeping this as a literal table removes the old tid==0 recurrent fill from
// the hot path. It is bit-identical to polar_qjl_signs().
constant float POLAR_QJL_SIGNS[QK_POLAR] = {
    -1.0f, -1.0f,  1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f,
     1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,  1.0f,
    -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f, -1.0f,
    -1.0f,  1.0f, -1.0f,  1.0f,  1.0f,  1.0f, -1.0f, -1.0f,
    -1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f,
    -1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f,  1.0f,
     1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,  1.0f,
     1.0f,  1.0f, -1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,
     1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f,  1.0f,  1.0f,
    -1.0f, -1.0f, -1.0f, -1.0f,  1.0f, -1.0f, -1.0f, -1.0f,
     1.0f, -1.0f, -1.0f,  1.0f,  1.0f,  1.0f,  1.0f, -1.0f,
    -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f,  1.0f,
     1.0f, -1.0f, -1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f,
    -1.0f,  1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f, -1.0f,
     1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f, -1.0f,
     1.0f,  1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,
};

struct block_q4_polar {
    half     d;
    uint8_t  qs[QK_POLAR / 2];
    uint8_t  qjl[QJL_RESIDUAL_BYTES];
};

struct polar_dequant_args {
    uint head_dim;          // must equal QK_POLAR (128)
    uint use_qjl;           // 0 / 1
};

// Threadgroup-cooperative 128-element Walsh-Hadamard butterfly. Each of
// 32 threads owns 2 of the 64 (a+b, a-b) butterfly pairs per stage. Pair
// index `p` maps to (j, j+h) with j = (p / h) * (2*h) + (p % h); within
// a single stage every index 0..127 is touched by exactly one pair, so
// reads and writes do not race. Only a between-stages barrier is needed.
//
// Caller MUST issue a barrier before invoking so the input fill (step 1+2
// or step 3) is visible to all threads.
static inline void polar_hadamard_inplace_tg32(threadgroup float * x, uint tid) {
    for (uint h = 1; h < QK_POLAR; h <<= 1) {
        // 64 pairs per stage, 2 pairs per thread.
        uint p0 = tid;          // 0..31
        uint p1 = tid + 32u;    // 32..63
        uint twoh = h << 1;
        uint b0 = (p0 / h) * twoh;
        uint o0 = p0 - (p0 / h) * h;     // p0 % h, branchless
        uint b1 = (p1 / h) * twoh;
        uint o1 = p1 - (p1 / h) * h;
        uint j0 = b0 + o0;
        uint j1 = b1 + o1;
        float a0 = x[j0];
        float c0 = x[j0 + h];
        float a1 = x[j1];
        float c1 = x[j1 + h];
        x[j0]     = a0 + c0;
        x[j0 + h] = a0 - c0;
        x[j1]     = a1 + c1;
        x[j1 + h] = a1 - c1;
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
}

// ---------- get_rows: decode one 128-element block to fp32 ----------
//
// Dispatch: one threadgroup per block. Threadgroup size = 32 (one Apple
// SIMD-group). Threads cooperate on the unpack, optional residual,
// Hadamard butterfly, and per-element rescale.

kernel void kernel_get_rows_q4_polar(
        device const block_q4_polar    * blk        [[buffer(0)]],   // single block
        device       float             * out        [[buffer(1)]],   // QK_POLAR floats
        constant     polar_dequant_args & args      [[buffer(2)]],
        uint                              tid       [[thread_position_in_threadgroup]],
        uint                              tg_size   [[threads_per_threadgroup]]) {
    if (args.head_dim != QK_POLAR) return;

    threadgroup float buf[QK_POLAR];

    // Step 1+2: unpack codes -> centroid values. 32 threads × 4 entries each
    // (we own 2 bytes = 4 elements per thread).
    for (uint b = tid; b < QK_POLAR / 2; b += tg_size) {
        uint8_t byte = blk->qs[b];
        buf[2 * b]     = POLAR_Q4_CENTROIDS[byte & 0x0Fu];
        buf[2 * b + 1] = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0Fu];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Step 3: optional QJL residual. The xorshift32(seed=42) sign vector is a
    // literal constant table, so all 32 threads can apply it directly.
    if (args.use_qjl != 0u) {
        float mag = POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
        uint  bit  = (uint)(blk->qjl[0] & 1u);
        float sign = bit ? 1.0f : -1.0f;
        float scaled = sign * mag;
        for (uint i = tid; i < QK_POLAR; i += tg_size) {
            buf[i] += scaled * POLAR_QJL_SIGNS[i];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }

    // Step 4: inverse Hadamard — threadgroup-cooperative 7-stage butterfly
    // (32 threads × 2 pairs per stage = 64 pairs, fully covers each stage).
    // The sequential variant ran all 448 ops on tid==0 and was the dominant
    // cost in this kernel; the cooperative variant collapses that into
    // 7 parallel stages with a barrier between each.
    polar_hadamard_inplace_tg32(buf, tid);

    // (1 / QK_POLAR) compensation + per-block L2 rescale folded into one
    // parallel multiply — turns the in-place butterfly into the orthonormal
    // inverse and applies the per-block norm in a single pass.
    float scale = float(blk->d) * POLAR_INV_QK;
    for (uint i = tid; i < QK_POLAR; i += tg_size) {
        out[i] = buf[i] * scale;
    }
}

// ---------- mul_mv: dot product against an fp32 activation chunk ----------
//
// Reference template: ggml_vec_dot_q4_polar_q8_0_ref.
//
// y[row] = <dequant(K_blocks[row]), q[QK_POLAR floats]>
//
// Dispatch: one threadgroup per row. Each thread handles 4 of QK_POLAR
// elements. Activation is fp32 here (not q8_0) to match the verification
// fixture format — the in-tree fork's hot-path equivalent will accept q8_0.

struct polar_mv_args {
    uint n_rows;
    uint head_dim;          // must equal QK_POLAR (128)
    uint use_qjl;           // 0 / 1
};

kernel void kernel_mul_mv_q4_polar_f32(
        device const block_q4_polar    * k_blocks   [[buffer(0)]],   // (n_rows)
        device const float             * q          [[buffer(1)]],   // (head_dim)
        device       float             * y          [[buffer(2)]],   // (n_rows)
        constant     polar_mv_args     & args       [[buffer(3)]],
        uint                              tid       [[thread_position_in_threadgroup]],
        uint                              row       [[threadgroup_position_in_grid]],
        uint                              tg_size   [[threads_per_threadgroup]]) {
    if (row >= args.n_rows || args.head_dim != QK_POLAR) return;

    threadgroup float buf[QK_POLAR];
    device const block_q4_polar * blk = k_blocks + row;

    // Step 1+2: unpack codes.
    for (uint b = tid; b < QK_POLAR / 2; b += tg_size) {
        uint8_t byte = blk->qs[b];
        buf[2 * b]     = POLAR_Q4_CENTROIDS[byte & 0x0Fu];
        buf[2 * b + 1] = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0Fu];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Step 3: optional QJL residual. Same constant-table path as get_rows.
    if (args.use_qjl != 0u) {
        float mag = POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
        uint  bit  = (uint)(blk->qjl[0] & 1u);
        float sign = bit ? 1.0f : -1.0f;
        float scaled = sign * mag;
        for (uint i = tid; i < QK_POLAR; i += tg_size) {
            buf[i] += scaled * POLAR_QJL_SIGNS[i];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }

    // Step 4: inverse Hadamard — threadgroup-cooperative 32-thread butterfly.
    // This path was the dominant cost (~5700 µs/dispatch in the bench).
    polar_hadamard_inplace_tg32(buf, tid);

    // Step 5: dot product against q[]. Fold the (1/QK_POLAR) Hadamard
    // compensation and per-block L2 norm into one final scalar applied
    // after the simd reduction — saves a parallel multiply pass over buf[].
    float acc = 0.0f;
    for (uint i = tid; i < QK_POLAR; i += tg_size) {
        acc = fma(buf[i], q[i], acc);
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        float l2 = float(blk->d);
        y[row] = sum * l2 * POLAR_INV_QK;
    }
}

// ---------- mul_mv: hot path with pre-Hadamard query ----------
//
// Uses the identity dot(H*x, q) == dot(x, H*q). The caller passes q_preht =
// H*q using the same unnormalised 128-point Walsh-Hadamard convention as the
// decoder. This avoids the per-row threadgroup scratch buffer and 7-stage
// butterfly in the attention-score hot path. The final scale is still
// per-block_l2 / QK_POLAR.
kernel void kernel_mul_mv_q4_polar_preht_f32(
        device const block_q4_polar    * k_blocks   [[buffer(0)]],
        device const float             * q_preht    [[buffer(1)]],
        device       float             * y          [[buffer(2)]],
        constant     polar_mv_args     & args       [[buffer(3)]],
        uint                              tid       [[thread_position_in_threadgroup]],
        uint                              row       [[threadgroup_position_in_grid]],
        uint                              tg_size   [[threads_per_threadgroup]]) {
    if (row >= args.n_rows || args.head_dim != QK_POLAR) return;

    device const block_q4_polar * blk = k_blocks + row;

    float acc = 0.0f;
    float scaled = 0.0f;
    if (args.use_qjl != 0u) {
        float mag = POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
        uint  bit  = (uint)(blk->qjl[0] & 1u);
        float sign = bit ? 1.0f : -1.0f;
        scaled = sign * mag;
    }
    for (uint b = tid; b < QK_POLAR / 2; b += tg_size) {
        uint8_t byte = blk->qs[b];
        uint i0 = 2u * b;
        uint i1 = i0 + 1u;
        float x0 = POLAR_Q4_CENTROIDS[byte & 0x0Fu];
        float x1 = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0Fu];

        if (args.use_qjl != 0u) {
            x0 += scaled * POLAR_QJL_SIGNS[i0];
            x1 += scaled * POLAR_QJL_SIGNS[i1];
        }

        acc = fma(x0, q_preht[i0], acc);
        acc = fma(x1, q_preht[i1], acc);
    }

    float sum = simd_sum(acc);
    if (tid == 0) {
        y[row] = sum * float(blk->d) * POLAR_INV_QK;
    }
}
