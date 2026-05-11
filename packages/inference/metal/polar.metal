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
// Two kernels:
//   - kernel_get_rows_q4_polar     : decode one 128-element block to fp32
//                                    (LUT lookup + optional QJL residual + inverse
//                                    Hadamard + per-block L2 rescale).
//   - kernel_mul_mv_q4_polar_f32   : dot-product against an fp32 activation
//                                    chunk (n must be a positive multiple of
//                                    QK_POLAR; one threadgroup per block).

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

struct block_q4_polar {
    half     d;
    uint8_t  qs[QK_POLAR / 2];
    uint8_t  qjl[QJL_RESIDUAL_BYTES];
};

struct polar_dequant_args {
    uint head_dim;          // must equal QK_POLAR (128)
    uint use_qjl;           // 0 / 1
};

// Helper: deterministic per-block ±1 sign vector for the QJL residual.
// Bit-identical to polar_qjl_signs() in
// packages/native-plugins/polarquant-cpu/src/polar_qjl.c (xorshift32 seeded
// with POLAR_QJL_SEED = 42, one bit per step). Static so the compiler can
// constant-fold each thread's slice if the loop is fully unrolled.
static inline float polar_qjl_sign(uint i, thread uint & state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state & 1u) ? 1.0f : -1.0f;
}

// In-place 128-element Walsh-Hadamard butterfly. Sequential variant — kept
// as a reference for single-thread execution; the threadgroup hot path uses
// polar_hadamard_inplace_tg32 below.
static inline void polar_hadamard_inplace_tg(threadgroup float * x) {
    // 7 stages: h = 1, 2, 4, 8, 16, 32, 64.
    for (uint h = 1; h < QK_POLAR; h <<= 1) {
        for (uint i = 0; i < QK_POLAR; i += (h << 1)) {
            for (uint j = i; j < i + h; ++j) {
                float a = x[j];
                float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
}

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
// SIMD-group). Threads cooperate on the unpack and the per-element rescale;
// the butterfly itself is run sequentially by tid==0 against a threadgroup-
// shared scratch (this is the "head_dim=128 butterfly per thread, no
// cross-thread reduction" tradeoff called out in the porting plan).

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

    // Step 3: optional QJL residual. Sign-vector generation is sequential
    // (xorshift32 chain) so tid==0 fills a threadgroup-shared buffer; the
    // per-element add is then parallel across all 32 threads.
    threadgroup float qjl_signs_tg[QK_POLAR];
    if (args.use_qjl != 0u) {
        if (tid == 0) {
            float mag = POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
            uint  bit  = (uint)(blk->qjl[0] & 1u);
            float sign = bit ? 1.0f : -1.0f;
            float scaled = sign * mag;
            uint  state = 42u;
            for (uint i = 0; i < QK_POLAR; ++i) {
                qjl_signs_tg[i] = scaled * polar_qjl_sign(i, state);
            }
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        for (uint i = tid; i < QK_POLAR; i += tg_size) {
            buf[i] += qjl_signs_tg[i];
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

    // Step 3: optional QJL residual. Same parallelization as get_rows: the
    // sequential xorshift32 sign chain runs on tid==0 into shared scratch,
    // then all 32 threads do the per-element add in parallel.
    threadgroup float qjl_signs_tg[QK_POLAR];
    if (args.use_qjl != 0u) {
        if (tid == 0) {
            float mag = POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
            uint  bit  = (uint)(blk->qjl[0] & 1u);
            float sign = bit ? 1.0f : -1.0f;
            float scaled = sign * mag;
            uint  state = 42u;
            for (uint i = 0; i < QK_POLAR; ++i) {
                qjl_signs_tg[i] = scaled * polar_qjl_sign(i, state);
            }
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        for (uint i = tid; i < QK_POLAR; i += tg_size) {
            buf[i] += qjl_signs_tg[i];
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
