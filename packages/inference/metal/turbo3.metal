// DRAFT: COMPILED locally NOT YET — agent runs on Linux without xcrun metal.
// SOURCE-LEVEL VERIFIED against fork's dequantize_turbo3_0_t4 at
// ggml/src/ggml-metal/ggml-metal.metal:700 (commit 6575873e9c). Byte layout
// and centroid lookup are bit-identical. Hardware verification still required
// before use — see packages/inference/README.md "Verification matrix".
//
// turbo3 KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Ports buun-llama-cpp's CUDA dequantize_turbo3_0 from
// ggml/src/ggml-cuda/turbo-quant-cuda.cuh and matches the fork's Metal
// dequantize_turbo3_0_t4 byte-for-byte.
//
// Block layout (block_turbo3_0 in ggml-common.h, 14 bytes):
//     half  norm                 // [0..1]   fp16 corrected group norm
//     uchar qs[8]                // [2..9]   QK_TURBO3/4 = 8 bytes (4 elements per byte, low 2 bits)
//     uchar signs[4]             // [10..13] QK_TURBO3/8 = 4 bytes (1 sign-bit per element)
//
// Element decode (matches fork's _t4 path):
//     elem 0..31 within a 32-element block:
//         qb  = qs[elem >> 2]                           // 4 elements per byte
//         low2 = (qb >> ((elem & 3) * 2)) & 0x3
//         sb  = signs[elem >> 3]                        // 1 bit per element
//         hi1 = (sb >> (elem & 7)) & 0x1
//         idx = low2 | (hi1 << 2)                       // full 3-bit index
//         k   = TURBO_CENTROIDS_3BIT[idx] * norm
//
// Four 32-element blocks form one 128-element rotation group. Graph
// pre-rotates Q (FWHT seed=42), so the shader skips inverse rotation.
//
// Dispatch: one threadgroup per (n_kv, n_head). Threadgroup size MUST equal
// 32 (one Apple SIMD-group). Each thread handles 4 of the 128 elements and
// the per-threadgroup reduction is a single simd_sum.

#include <metal_stdlib>
using namespace metal;

// Match block_turbo3_0 layout exactly (14 bytes, alignment 2).
struct block_turbo3_0 {
    half     norm;
    uint8_t  qs[8];
    uint8_t  signs[4];
};

constant float TURBO_CENTROIDS_3BIT[8] = {
    -0.190685f, -0.117832f, -0.065717f, -0.021460f,
     0.021460f,  0.065717f,  0.117832f,  0.190685f,
};

struct turbo_dot_args {
    uint head_dim;          // must be 128
    uint n_kv;
    uint kv_stride_blocks;  // 4 for d=128 (4 blocks per group)
    uint q_head;
    uint head_offset_bytes; // must be a multiple of sizeof(block_turbo3_0) (14)
};

kernel void kernel_turbo3_dot(
        device const float          * q             [[buffer(0)]],
        device const block_turbo3_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_args & args          [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          kv_idx        [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv) return;

    // Resolve the 4-block group for this KV index. Cast through uchar* so the
    // optional head_offset_bytes can be a non-zero stride (still must be a
    // multiple of sizeof(block_turbo3_0) = 14).
    device const block_turbo3_0 * grp =
        (device const block_turbo3_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;

    // 32 threads × 4 elements = 128 head_dim entries. Each thread's 4 elements
    // (tid*4 + 0..3) lie wholly within ONE 32-element block (since 32 is a
    // multiple of 4 and tid*4 ∈ {0,4,...,124}). Hoist block/norm/byte loads
    // out of the inner loop — they are constant for the four `local` iters.
    uint elem0   = tid * 4;                        // 0,4,...,124
    uint blk_idx = elem0 >> 5;                     // 0..3
    uint within0 = elem0 & 31;                     // 0,4,...,28
    device const block_turbo3_0 & blk = grp[blk_idx];
    float norm = float(blk.norm);
    // All four elements of this thread share the same qs[] byte (within>>2 is
    // constant for within = within0..within0+3) and the same signs[] byte
    // (within>>3 is constant for within = within0..within0+3).
    uint qb = blk.qs[within0 >> 2];
    uint sb = blk.signs[within0 >> 3];
    uint q_base = args.q_head * args.head_dim + elem0;

    float acc = 0.0f;
    for (uint local = 0; local < 4; ++local) {
        uint within = within0 + local;            // within0..within0+3
        uint low2 = (qb >> ((within & 3) * 2)) & 0x3;
        uint hi1  = (sb >> (within & 7)) & 0x1;
        uint idx  = low2 | (hi1 << 2);

        float k_val = TURBO_CENTROIDS_3BIT[idx] * norm;
        float q_val = q[q_base + local];
        acc = fma(q_val, k_val, acc);
    }

    // Threadgroup reduction. With threadgroup size == SIMD-group size == 32,
    // simd_sum returns the full 128-element dot product to every lane and lane
    // 0 writes the result. If the dispatch ever uses a larger threadgroup,
    // this needs to switch to threadgroup-shared storage + barrier.
    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}
