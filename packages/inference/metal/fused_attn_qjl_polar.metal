// Hardware-verified on Apple M4 Max via `make metal-verify-fused`.
//
// Fused attention: QJL-K score + Q4_POLAR-V mix, online softmax that never
// materializes the per-token score vector. Metal Shading Language. The Polar
// V-mix variant of GGML_OP_FUSED_ATTN_QJL_TBQ — see
// reports/porting/2026-05-11/fused-attn-op-contract.md (§1, §2: block_q4_polar
// V; §3: op_params[2] = v_use_qjl) and the C reference eliza_fused_attn_qjl_polar()
// in packages/inference/verify/qjl_polar_ref.c. Mirrors the hardware-verified
// Vulkan port fused_attn_qjl_polar.comp (Intel ARL Mesa ANV); this Metal version
// is also hardware-verified on Apple M4 Max runtime JIT.
//
// Same K side and same one-pass online-softmax structure as
// fused_attn_qjl_tbq.metal; the only difference is the V decode — one
// block_q4_polar (82 B) per token instead of four block_tbq3_0:
//     half  d                          per-block L2 norm
//     uchar qs[64]                     128 4-bit centroid codes, low nibble first
//     uchar qjl[16]                    optional 1-bit QJL residual (use_qjl)
//   decode (mirrors dequantize_row_q4_polar_ref / eliza_polar_dequantize_row):
//     1. unpack 4-bit codes -> POLAR_Q4_CENTROIDS LUT
//     2. optional QJL residual: 1 sign bit on the xorshift32(seed=42) ±1 vector,
//        magnitude 0.5 / sqrt(128), added before the per-block Hadamard
//     3. in-place 128-element Walsh-Hadamard butterfly (7 stages)
//     4. x (1/128)  (orthonormal-inverse Hadamard compensation)
//     5. x fp16 norm
//   The result is the *real* head-dim V vector (no further uncondition).
//
// One threadgroup per (q_head, q_pos); threadgroup size MUST be 32 (one Apple
// SIMD-group). Per-token QJL score reduction is one simd_sum; the Polar
// Hadamard-128 and the output accumulator live in threadgroup scratch.

#include <metal_stdlib>
using namespace metal;

#define QJL_PROJECTION_DIM  256
#define QJL_PACKED_BYTES    32
#define HEAD_DIM            128          // == QK_POLAR
#define QK_POLAR            128
#define QJL_RESIDUAL_BYTES  (QK_POLAR / 8)
#define POLAR_Q4_N_LEVELS   16

struct block_qjl1_256 {
    uint8_t  qs[QJL_PACKED_BYTES];
    ushort   norm_bf16;
};

struct block_q4_polar {
    half     d;
    uint8_t  qs[QK_POLAR / 2];
    uint8_t  qjl[QJL_RESIDUAL_BYTES];
};

constant float QJL_SCORE_SCALE  = 1.2533141373155003f / float(QJL_PROJECTION_DIM);
constant float POLAR_INV_QK     = 1.0f / float(QK_POLAR);          // (1 / QK_POLAR) Hadamard compensation
constant float POLAR_QJL_CORRECTION_MAGNITUDE = 0.5f;
constant float POLAR_QJL_INV_SQRT_QK = 0.08838834764831845f;      // 1/sqrt(128)

// Bit-identical to POLAR_Q4_CENTROIDS in polarquant-cpu/include/polarquant/polar_centroids.h.
constant float POLAR_Q4_CENTROIDS[POLAR_Q4_N_LEVELS] = {
    -2.754354807f, -2.093562707f, -1.643041510f, -1.279739752f,
    -0.962640978f, -0.672392117f, -0.397897103f, -0.131757782f,
     0.131757782f,  0.397897103f,  0.672392117f,  0.962640978f,
     1.279739752f,  1.643041510f,  2.093562707f,  2.754354807f,
};
// xorshift32(seed=42) sign vector for the optional Polar QJL residual
// (bit-identical to polar_qjl_signs() / eliza_polar_qjl_signs).
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

struct fused_attn_args {
    uint head_dim;        // 128
    uint proj_dim;        // 256 (QJL side)
    uint n_heads;
    uint n_kv_heads;
    uint n_q_pos;
    uint n_kv;
    uint kv_tile;         // 0 == whole range
    uint v_use_qjl;       // Polar V-cache 1-bit residual present (0/1)
    float scale;
    uint causal;
    uint q_pos_base;
};

static inline float bf16_to_fp32(ushort b) { return as_type<float>(((uint)b) << 16); }

// Threadgroup-cooperative 128-element Walsh-Hadamard butterfly. Each of 32
// lanes owns 2 of the 64 (a+b, a-b) butterfly pairs per stage; within a single
// stage every index 0..127 is touched by exactly one pair so no race. Caller
// barriers before (input visible) and after. Mirrors polar.metal's
// polar_hadamard_inplace_tg32.
static inline void polar_hadamard_inplace_tg32(threadgroup float * x, uint tid) {
    for (uint h = 1u; h < QK_POLAR; h <<= 1u) {
        uint p0 = tid;          // 0..31
        uint p1 = tid + 32u;    // 32..63
        uint twoh = h << 1u;
        uint b0 = (p0 / h) * twoh;
        uint o0 = p0 - (p0 / h) * h;
        uint b1 = (p1 / h) * twoh;
        uint o1 = p1 - (p1 / h) * h;
        uint j0 = b0 + o0;
        uint j1 = b1 + o1;
        float a0 = x[j0]; float c0 = x[j0 + h];
        float a1 = x[j1]; float c1 = x[j1 + h];
        x[j0]     = a0 + c0; x[j0 + h] = a0 - c0;
        x[j1]     = a1 + c1; x[j1 + h] = a1 - c1;
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
}

static inline float qjl_score_one_token(
        device const float * q_sketch,
        device const block_qjl1_256 * pk_head,
        uint h_q, uint q_pos, uint n_heads, uint t, float sm_scale, uint tid) {
    device const block_qjl1_256 & blk = pk_head[t];
    uint bits  = blk.qs[tid];
    uint base  = tid * 8u;
    uint q_off = (q_pos * n_heads + h_q) * QJL_PROJECTION_DIM + base;
    device const float4 * qs4 = (device const float4 *)(q_sketch + q_off);
    float4 q0 = qs4[0];
    float4 q1 = qs4[1];
    float4 s0 = float4(
        float(int(((bits >> 0) & 1u) << 1) - 1),
        float(int(((bits >> 1) & 1u) << 1) - 1),
        float(int(((bits >> 2) & 1u) << 1) - 1),
        float(int(((bits >> 3) & 1u) << 1) - 1));
    float4 s1 = float4(
        float(int(((bits >> 4) & 1u) << 1) - 1),
        float(int(((bits >> 5) & 1u) << 1) - 1),
        float(int(((bits >> 6) & 1u) << 1) - 1),
        float(int(((bits >> 7) & 1u) << 1) - 1));
    float4 acc4 = fma(q0, s0, fma(q1, s1, float4(0.0f)));
    float acc = acc4.x + acc4.y + acc4.z + acc4.w;
    float dot_v = simd_sum(acc);
    return QJL_SCORE_SCALE * bf16_to_fp32(blk.norm_bf16) * dot_v * sm_scale;
}

// Decode one block_q4_polar -> 128 real head-dim V values via v_buf, FMA into
// acc_o: acc_o[d] = acc_o[d]*corr + w*dec[d]. Collective; caller barriers
// before/after to reuse v_buf across tokens.
static inline void polar_decode_token_into_acc(
        device const block_q4_polar * blk,
        threadgroup float * v_buf,
        threadgroup float * acc_o,
        float w, float corr, uint use_qjl, uint tid) {
    // Step 1: unpack 4-bit codes -> centroids (32 lanes x 2 bytes covers 64).
    for (uint b = tid; b < HEAD_DIM / 2u; b += 32u) {
        uint8_t byte = blk->qs[b];
        v_buf[2u * b]      = POLAR_Q4_CENTROIDS[byte & 0x0Fu];
        v_buf[2u * b + 1u] = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0Fu];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    // Step 2: optional QJL residual.
    if (use_qjl != 0u) {
        uint  bit  = (uint)(blk->qjl[0] & 1u);
        float sign_v = bit ? 1.0f : -1.0f;
        float scaled = sign_v * POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
        for (uint i = tid; i < HEAD_DIM; i += 32u) v_buf[i] += scaled * POLAR_QJL_SIGNS[i];
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    // Step 3: in-place Hadamard-128.
    polar_hadamard_inplace_tg32(v_buf, tid);
    // Steps 4+5: x (1/128) x fp16 norm, then FMA into acc_o.
    float l2 = float(blk->d);
    float scale = w * l2 * POLAR_INV_QK;
    for (uint i = tid; i < HEAD_DIM; i += 32u) acc_o[i] = acc_o[i] * corr + scale * v_buf[i];
    threadgroup_barrier(mem_flags::mem_threadgroup);
}

kernel void kernel_fused_attn_qjl_polar_f32(
        device const float          * q_sketch  [[buffer(0)]],   // (n_q_pos, n_heads, 256)
        device const block_qjl1_256 * k_packed  [[buffer(1)]],   // (n_kv_heads, n_kv) 34 B/token
        device const block_q4_polar * v_packed  [[buffer(2)]],   // (n_kv_heads, n_kv) 82 B/token
        device       float          * out_attn  [[buffer(3)]],   // (n_q_pos, n_heads, 128)
        constant     fused_attn_args & args      [[buffer(4)]],
        uint3                          tid3      [[thread_position_in_threadgroup]],
        uint3                          tg_pos    [[threadgroup_position_in_grid]]) {
    if (args.head_dim != HEAD_DIM || args.proj_dim != QJL_PROJECTION_DIM) return;
    uint tid   = tid3.x;
    uint h_q   = tg_pos.x;
    uint q_pos = tg_pos.y;
    if (h_q >= args.n_heads || q_pos >= args.n_q_pos) return;

    threadgroup float acc_o[HEAD_DIM];
    threadgroup float v_buf[HEAD_DIM];     // one decoded V block, staged per token

    uint gqa  = args.n_heads / args.n_kv_heads;
    uint h_k  = h_q / gqa;
    uint out_base = (q_pos * args.n_heads + h_q) * HEAD_DIM;
    device const block_qjl1_256 * pk_head = k_packed + (size_t)h_k * args.n_kv;
    device const block_q4_polar * pv_head = v_packed + (size_t)h_k * args.n_kv;
    float sm_scale = args.scale;

    if (args.n_kv == 0u) {
        for (uint i = tid; i < HEAD_DIM; i += 32u) out_attn[out_base + i] = 0.0f;
        return;
    }
    uint q_abs = args.q_pos_base + q_pos;

    // --- Single online-softmax pass over the KV tokens. The running (m, l)
    //     are thread-uniform: qjl_score_one_token returns the same raw score
    //     to every lane after the cooperative simd_sum. ---
    float m = -1.0e30f;
    float l = 0.0f;
    for (uint i = tid; i < HEAD_DIM; i += 32u) acc_o[i] = 0.0f;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint t = 0u; t < args.n_kv; t++) {
        if (args.causal != 0u && t > q_abs) break;
        float raw = qjl_score_one_token(q_sketch, pk_head, h_q, q_pos, args.n_heads, t, sm_scale, tid);
        float new_m = max(m, raw);
        float corr = exp(m - new_m);
        float w = exp(raw - new_m);
        l = l * corr + w;
        m = new_m;
        threadgroup_barrier(mem_flags::mem_threadgroup);
        polar_decode_token_into_acc(pv_head + t, v_buf, acc_o, w, corr, args.v_use_qjl, tid);
    }
    if (!isfinite(m) || m <= -1.0e29f || !(l > 0.0f)) {
        for (uint i = tid; i < HEAD_DIM; i += 32u) out_attn[out_base + i] = 0.0f;
        return;
    }
    float inv_l = 1.0f / l;
    for (uint i = tid; i < HEAD_DIM; i += 32u) acc_o[i] *= inv_l;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    if (tid == 0u) {
        for (uint i = 0u; i < HEAD_DIM; i++) out_attn[out_base + i] = acc_o[i];
    }
}
