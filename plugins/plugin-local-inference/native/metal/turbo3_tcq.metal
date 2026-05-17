// HARDWARE VERIFIED on Apple M4 Max (Metal runtime JIT): 8/8 PASS against the
// fixture harness. Source-level verified against the CUDA dequantize_turbo3_tcq
// decode path (sliding 9-bit window, codebook lookup) and the reference C impl.
//
// turbo3_tcq KV cache dequant + Q·K dot product (Metal Shading Language).
//
// Decode-only: the 512-state Viterbi encode path runs host-side via the
// reference C impl. Decode = read_9_bits(qs, t*3); recon = codebook[state] * norm.
//
// Block layout (block_turbo3_tcq in ggml-common.h, 52 bytes, alignment 2):
//     half  norm                 // [0..1]
//     uchar qs[49]               // [2..50]  6 prefix bits + 128 × 3-bit symbols
//     uchar pad                  // [51]
//
// Dispatch: one threadgroup per (n_kv, n_head). Threadgroup size MUST equal
// 32 (one Apple SIMD-group). Each thread handles 4 of the 128 timesteps.

#include <metal_stdlib>
using namespace metal;

struct block_turbo3_tcq {
    half     norm;
    uint8_t  qs[49];
    uint8_t  pad;
};

struct turbo_dot_args {
    uint head_dim;          // must be 128
    uint n_kv;
    uint kv_stride_blocks;  // 1 for d=128
    uint q_head;
    uint head_offset_bytes; // must be a multiple of sizeof(block_turbo3_tcq) (52)
};

// Codebook bound at buffer(3) (512 entries = 2 KB; well under Apple's
// constant-address-space cap). Sharing as a buffer instead of inlining
// avoids 2 KB of constant memory per shader-variant baked into the library.
kernel void kernel_turbo3_tcq_dot(
        device const float            * q             [[buffer(0)]],
        device const block_turbo3_tcq * k_blocks      [[buffer(1)]],
        device       float            * scores        [[buffer(2)]],
        constant     float            * codebook      [[buffer(3)]],   // 512 entries
        constant     turbo_dot_args   & args          [[buffer(4)]],
        uint                            tid           [[thread_position_in_threadgroup]],
        uint                            kv_idx        [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv) return;

    device const block_turbo3_tcq * blk =
        (device const block_turbo3_tcq *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;

    float norm = float(blk->norm);
    uint q_base = args.q_head * args.head_dim + tid * 4;

    // Each thread handles four consecutive 3-bit TCQ symbols. Their 9-bit
    // decode windows overlap, so one 24-bit preload covers all four states.
    uint bit_pos0  = tid * 12;             // (tid * 4) * 3
    uint byte_idx0 = bit_pos0 >> 3;
    uint bit_off0  = bit_pos0 & 7;
    uint raw24 = uint(blk->qs[byte_idx0])
        | (uint(blk->qs[byte_idx0 + 1]) << 8)
        | (uint(blk->qs[byte_idx0 + 2]) << 16);

    device const float4 * q4 = (device const float4 *)(q + q_base);
    float4 qv = q4[0];
    uint state0 = (raw24 >> (bit_off0 + 0u)) & 0x1FFu;
    uint state1 = (raw24 >> (bit_off0 + 3u)) & 0x1FFu;
    uint state2 = (raw24 >> (bit_off0 + 6u)) & 0x1FFu;
    uint state3 = (raw24 >> (bit_off0 + 9u)) & 0x1FFu;
    float4 kv = float4(codebook[state0], codebook[state1], codebook[state2], codebook[state3]) * norm;
    float acc = dot(qv, kv);

    float sum = simd_sum(acc);
    if (tid == 0) {
        scores[args.q_head * args.n_kv + kv_idx] = sum;
    }
}

// Multi-block-per-dispatch variant. Same math as kernel_turbo3_tcq_dot; the
// threadgroup processes `blocks_per_threadgroup` consecutive KV indices in a
// 32-thread serial loop to amortise dispatch launch tax.
struct turbo_dot_multi_args {
    uint head_dim;
    uint n_kv;
    uint kv_stride_blocks;
    uint q_head;
    uint head_offset_bytes;
    uint blocks_per_threadgroup;
};

kernel void kernel_turbo3_tcq_dot_multi(
        device const float            * q             [[buffer(0)]],
        device const block_turbo3_tcq * k_blocks      [[buffer(1)]],
        device       float            * scores        [[buffer(2)]],
        constant     float            * codebook      [[buffer(3)]],
        constant     turbo_dot_multi_args & args      [[buffer(4)]],
        uint                            tid           [[thread_position_in_threadgroup]],
        uint                            tg_idx        [[threadgroup_position_in_grid]]) {
    uint q_base = args.q_head * args.head_dim + tid * 4;
    uint bit_pos0  = tid * 12;
    uint byte_idx0 = bit_pos0 >> 3;
    uint bit_off0  = bit_pos0 & 7;
    device const float4 * q4 = (device const float4 *)(q + q_base);
    float4 qv = q4[0];

    uint kv_base = tg_idx * args.blocks_per_threadgroup;
    for (uint b = 0; b < args.blocks_per_threadgroup; ++b) {
        uint kv_idx = kv_base + b;
        if (kv_idx >= args.n_kv) return;

        device const block_turbo3_tcq * blk =
            (device const block_turbo3_tcq *)((device const uchar *)k_blocks + args.head_offset_bytes)
            + kv_idx * args.kv_stride_blocks;
        float norm = float(blk->norm);

        uint raw24 = uint(blk->qs[byte_idx0])
            | (uint(blk->qs[byte_idx0 + 1]) << 8)
            | (uint(blk->qs[byte_idx0 + 2]) << 16);

        uint state0 = (raw24 >> (bit_off0 + 0u)) & 0x1FFu;
        uint state1 = (raw24 >> (bit_off0 + 3u)) & 0x1FFu;
        uint state2 = (raw24 >> (bit_off0 + 6u)) & 0x1FFu;
        uint state3 = (raw24 >> (bit_off0 + 9u)) & 0x1FFu;
        float4 kv = float4(codebook[state0], codebook[state1], codebook[state2], codebook[state3]) * norm;
        float acc = dot(qv, kv);

        float sum = simd_sum(acc);
        if (tid == 0) {
            scores[args.q_head * args.n_kv + kv_idx] = sum;
        }
    }
}
