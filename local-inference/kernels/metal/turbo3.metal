// DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
//
// turbo3 KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Ports buun-llama-cpp's CUDA dequantize_turbo3_0 from
// ggml/src/ggml-cuda/turbo-quant-cuda.cuh (commit 6575873e9c) and matches the
// Metal `dequantize_turbo3_0_t4` template at
// ggml/src/ggml-metal/ggml-metal.metal:700.
//
// Block layout (block_turbo3_0 in ggml-common.h, 14 bytes):
//     half  norm                 // [0..1]   fp16 corrected group norm
//     uchar qs[8]                // [2..9]   QK_TURBO3/4 = 8 bytes (4 elements per byte, low 2 bits)
//     uchar signs[4]             // [10..13] QK_TURBO3/8 = 4 bytes (1 sign-bit per element)
//
// Four 32-element blocks form one 128-element rotation group. Graph
// pre-rotates Q (FWHT seed=42), so the shader skips inverse rotation.
//
// Dispatch: one threadgroup per (n_kv_block, n_head). 32 threads per group.

#include <metal_stdlib>
using namespace metal;

// Match block_turbo3_0 layout exactly (14 bytes, packed).
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
    uint head_offset_bytes;
};

// CUDA: k_packed indexed as block_turbo3_0[]. Metal lets us take a typed view
// directly. Q is fp32 head-major.
kernel void kernel_turbo3_dot(
        device const float          * q             [[buffer(0)]],
        device const block_turbo3_0 * k_blocks      [[buffer(1)]],
        device       float          * scores        [[buffer(2)]],
        constant     turbo_dot_args & args          [[buffer(3)]],
        uint                          tid           [[thread_position_in_threadgroup]],
        uint                          kv_idx        [[threadgroup_position_in_grid]],
        uint                          tg_size       [[threads_per_threadgroup]]) {
    if (kv_idx >= args.n_kv) return;

    // The 4-block group for this KV index. head_offset_bytes must be a
    // multiple of sizeof(block_turbo3_0) for the typed view to be valid.
    device const block_turbo3_0 * grp =
        (device const block_turbo3_0 *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;

    // 32 threads × 4 elements = 128 head_dim entries.
    float acc = 0.0f;
    for (uint local = 0; local < 4; ++local) {
        uint elem = tid * 4 + local;          // 0..127
        uint blk_idx = elem >> 5;             // 0..3
        uint within  = elem & 31;             // 0..31

        device const block_turbo3_0 & blk = grp[blk_idx];
        float norm = float(blk.norm);

        uint qb  = blk.qs[within >> 2];                                // 4 elements per byte
        uint low2 = (qb >> ((within & 3) * 2)) & 0x3;
        uint sb  = blk.signs[within >> 3];
        uint hi1 = (sb >> (within & 7)) & 0x1;
        uint idx = low2 | (hi1 << 2);

        float k_val = TURBO_CENTROIDS_3BIT[idx] * norm;
        float q_val = q[args.q_head * args.head_dim + elem];
        acc += q_val * k_val;
    }

    // Threadgroup reduction. simd_sum across the 32-thread SIMD-group.
    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}
