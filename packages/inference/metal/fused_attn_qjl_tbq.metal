// Hardware-verified on Apple M4 Max via `make metal-verify-fused`.
//
// Fused attention: QJL-K score + TBQ3-V mix, online softmax that never
// materializes the per-token score vector. Metal Shading Language. Ports
// GGML_OP_FUSED_ATTN_QJL_TBQ — see the backend-neutral contract in
// reports/porting/2026-05-11/fused-attn-op-contract.md and the Metal design
// reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md (Part 2),
// byte-faithful to the C reference eliza_fused_attn_qjl_tbq3() in
// packages/inference/verify/qjl_polar_ref.c (bit-exact to fused_attn_qjl_tbq_ref
// in the milady-llama-cpp fork). Hardware-verified bit-for-bit on both the
// Vulkan port (fused_attn_qjl_tbq.comp, Intel ARL Mesa ANV) and this Metal
// mirror (Apple M4 Max runtime JIT).
//
// One threadgroup per (q_head, q_pos); threadgroup size MUST be 32 (one Apple
// SIMD-group — every other shader in this dir relies on simd_sum covering the
// whole reduction). Each lane owns one byte of the 32-byte QJL sign vector and
// 8 of the 256 sketch elements; the per-token score reduction is one simd_sum.
// The TBQ Hadamard-32 uncondition and the output accumulator live in threadgroup
// scratch (no subgroup assumption beyond the 32-lane simd_sum).
//
// Geometry (binding): head_dim 128 (= 4 * QK_TBQ), proj_dim 256 (QJL sketch
// dim, NOT head_dim), QK_TBQ 32 (4 TBQ3 blocks per V row).
//
// K side — block_qjl1_256 (34 B/token):  uchar qs[32]; ushort norm_bf16
// V side — block_tbq3_0 (14 B/token, 4 per token = 56 B):
//          ushort d (fp16 block RMS); uchar qs[12] (32 3-bit codes, LSB-first)
//   decode: d * TBQ3_CODEBOOK[code]  ->  Hadamard-32 (x 0.17677...)  ->  x ±1
//   sign vector (the "uncondition" step — the fused V-mix needs the *real*
//   head-dim V, not the rotated representation, unlike the standalone
//   kernel_turbo3_dot score path which deliberately skips the uncondition).
//
// Online softmax: one pass walks KV once, maintaining thread-uniform running
// (m, l). When m increases, the shared output accumulator is rescaled by
// corr = exp(m_old - m_new), then the current decoded V block is FMAed with
// w = exp(raw - m_new). After the loop, the accumulator is divided by l.
// This is algebraically identical to the two-pass reference but avoids
// recomputing every QJL score on Metal.
//
// kv_tile (op-param): KV positions per online-softmax tile. 0 == whole range;
// the verify path passes 0 and walks the full range — matching the C reference
// and the Vulkan port. A nonzero kv_tile (voice barge-in cancellation
// granularity) would subdivide pass 1/2 over [t0, t0+kv_tile); the dispatcher
// is expected to pass a small tile for voice graphs and a large one for prefill.

#include <metal_stdlib>
using namespace metal;

#define QJL_PROJECTION_DIM  256
#define QJL_PACKED_BYTES    32   // 256 / 8
#define HEAD_DIM            128
#define QK_TBQ              32
#define TBQ_PER_TOKEN       4    // HEAD_DIM / QK_TBQ
#define TBQ3_BLOCK_BYTES    14   // ushort d + uchar qs[12]

struct block_qjl1_256 {
    uint8_t  qs[QJL_PACKED_BYTES];
    ushort   norm_bf16;
};

// block_tbq3_0 (14 bytes, alignment 2) — fork ggml-common.h layout.
struct block_tbq3_0 {
    ushort   d;
    uint8_t  qs[12];
};

// sqrt(pi/2) / proj_dim — the canonical QJL paper score scalar; kept separate
// from sm_scale (the model's pre-softmax temperature) per the contract §5.
constant float QJL_SCORE_SCALE  = 1.2533141373155003f / float(QJL_PROJECTION_DIM);
// Hadamard-32 normalization (1 / sqrt(32)), folded into the inverse rotation.
constant float TBQ_HADAMARD_NORM = 0.1767766952966369f;

// TBQ3 codebook (8 centroids) — bit-identical to ELIZA_TBQ3_CODEBOOK.
constant float TBQ3_CODEBOOK[8] = {
    -2.1519457f, -1.3439093f, -0.7560053f, -0.2450942f,
     0.2450942f,  0.7560053f,  1.3439093f,  2.1519457f,
};
// Fixed ±1 sign vector for the TBQ uncondition step (ELIZA_TBQ_SIGNS_32_FORK).
constant float TBQ_SIGNS_32[32] = {
     1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,
     1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f,
    -1.0f,  1.0f,  1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f,
     1.0f, -1.0f,  1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,
};

struct fused_attn_args {
    uint head_dim;        // 128
    uint proj_dim;        // 256 (QJL side)
    uint n_heads;         // query heads
    uint n_kv_heads;      // GQA: h_kv = h_q / (n_heads / n_kv_heads)
    uint n_q_pos;         // query positions in this dispatch
    uint n_kv;            // KV length being attended
    uint kv_tile;         // KV positions per online-softmax tile (0 == whole range)
    uint v_use_qjl;       // unused for the TBQ V variant (kept for ABI symmetry)
    float scale;          // softmax scale (model's pre-softmax temperature)
    uint causal;          // 1 -> mask kv > q position
    uint q_pos_base;      // absolute position of q_pos 0 (causal masking)
};

static inline float bf16_to_fp32(ushort b) { return as_type<float>(((uint)b) << 16); }
static inline float fp16_to_fp32(ushort h) { return float(as_type<half>(h)); }

// 3-bit code lookup inside the 12-byte LSB-first qs[] of a block_tbq3_0.
static inline uint tbq3_get_code(const device uint8_t * qs, uint idx) {
    uint bit  = idx * 3u;
    uint byte = bit >> 3u;
    uint shift = bit & 7u;
    uint v = (uint)qs[byte] >> shift;
    if (shift > 5u && byte + 1u < 12u) v |= (uint)qs[byte + 1u] << (8u - shift);
    return v & 7u;
}

// 32-thread cooperative QJL score for token `t` of kv-head `h_k`, query head
// `h_q`, query position `q_pos`. Lane `tid` owns byte tid (8 sign bits / 8
// sketch elements). Collective: ALL 32 lanes must call together for the SAME
// token. Returns the per-token raw score (×sm_scale) to every lane.
static inline float qjl_score_one_token(
        device const block_qjl1_256 * pk_head,
        float4 q0, float4 q1, uint t, float sm_scale, uint tid) {
    device const block_qjl1_256 & blk = pk_head[t];
    uint bits  = blk.qs[tid];
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

// Decode one token's 4 block_tbq3_0 chunks into 128 unconditioned (real
// head-dim) V values via the threadgroup scratch tbq_buf and FMA them into
// acc_o:  acc_o[d] = acc_o[d]*corr + w*dec[d]. Collective; caller barriers
// before/after to reuse tbq_buf across tokens.
static inline void tbq3_decode_token_into_acc(
        device const block_tbq3_0 * v_token,   // 4 contiguous chunks
        threadgroup float * tbq_buf,
        threadgroup float * acc_o,
        float w, float corr, uint tid) {
    // Phase 1: codebook lookup, one element per lane per chunk (4 chunks).
    for (uint c = 0u; c < TBQ_PER_TOKEN; c++) {
        device const block_tbq3_0 & blk = v_token[c];
        float d = fp16_to_fp32(blk.d);
        tbq_buf[c * 32u + tid] = d * TBQ3_CODEBOOK[tbq3_get_code(blk.qs, tid)];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    // Phase 2: Hadamard-32 on each chunk; lanes [8c .. 8c+7] handle chunk c
    // (32 lanes / 4 chunks = 8/chunk; 16 butterfly pairs / 8 = 2 each).
    {
        uint chunk = tid >> 3u;          // 0..3
        uint lane  = tid & 7u;           // 0..7
        uint base  = chunk * 32u;
        for (uint len = 1u; len < 32u; len <<= 1u) {
            for (uint p = lane; p < 16u; p += 8u) {
                uint blk2 = (p / len) * (len << 1u);
                uint ofs  = p - (p / len) * len;
                uint j    = base + blk2 + ofs;
                float a = tbq_buf[j];
                float b = tbq_buf[j + len];
                tbq_buf[j]       = a + b;
                tbq_buf[j + len] = a - b;
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    // Phase 3: ±1 sign flip + folded (1/sqrt(32)), then FMA into acc_o.
    for (uint i = tid; i < HEAD_DIM; i += 32u) {
        float dec = tbq_buf[i] * TBQ_HADAMARD_NORM * TBQ_SIGNS_32[i & 31u];
        acc_o[i] = acc_o[i] * corr + w * dec;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
}

kernel void kernel_fused_attn_qjl_tbq3_f32(
        device const float          * q_sketch  [[buffer(0)]],   // (n_q_pos, n_heads, 256)
        device const block_qjl1_256 * k_packed  [[buffer(1)]],   // (n_kv_heads, n_kv) 34 B/token
        device const block_tbq3_0   * v_packed  [[buffer(2)]],   // (n_kv_heads, n_kv, 4) 14 B each
        device       float          * out_attn  [[buffer(3)]],   // (n_q_pos, n_heads, 128)
        constant     fused_attn_args & args      [[buffer(4)]],
        uint3                          tid3      [[thread_position_in_threadgroup]],
        uint3                          tg_pos    [[threadgroup_position_in_grid]]) {
    if (args.head_dim != HEAD_DIM || args.proj_dim != QJL_PROJECTION_DIM) return;
    uint tid   = tid3.x;
    uint h_q   = tg_pos.x;
    uint q_pos = tg_pos.y;
    if (h_q >= args.n_heads || q_pos >= args.n_q_pos) return;

    threadgroup float acc_o[HEAD_DIM];     // running attention-output accumulator
    threadgroup float tbq_buf[HEAD_DIM];   // 4 chunks x 32 decoded V floats, staged/token

    uint gqa  = args.n_heads / args.n_kv_heads;     // >= 1
    uint h_k  = h_q / gqa;
    uint out_base = (q_pos * args.n_heads + h_q) * HEAD_DIM;
    device const block_qjl1_256 * pk_head = k_packed + (size_t)h_k * args.n_kv;
    device const block_tbq3_0   * pv_head = v_packed + (size_t)h_k * args.n_kv * TBQ_PER_TOKEN;
    float sm_scale = args.scale;
    uint q_off = (q_pos * args.n_heads + h_q) * QJL_PROJECTION_DIM + tid * 8u;
    device const float4 * qs4 = (device const float4 *)(q_sketch + q_off);
    float4 q0 = qs4[0];
    float4 q1 = qs4[1];

    // Empty cache -> out = 0 (matches the reference memset on degenerate input).
    if (args.n_kv == 0u) {
        for (uint i = tid; i < HEAD_DIM; i += 32u) out_attn[out_base + i] = 0.0f;
        return;
    }

    // Causal masking is decided per-token below; for the pass-1 stats and the
    // output we walk the same masked set. q's absolute position:
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
        float raw = qjl_score_one_token(pk_head, q0, q1, t, sm_scale, tid);
        float new_m = max(m, raw);
        float corr = exp(m - new_m);
        float w = exp(raw - new_m);
        l = l * corr + w;
        m = new_m;
        tbq3_decode_token_into_acc(pv_head + (size_t)t * TBQ_PER_TOKEN, tbq_buf, acc_o, w, corr, tid);
    }
    if (!isfinite(m) || m <= -1.0e29f || !(l > 0.0f)) {
        for (uint i = tid; i < HEAD_DIM; i += 32u) out_attn[out_base + i] = 0.0f;
        return;
    }
    float inv_l = 1.0f / l;
    for (uint i = tid; i < HEAD_DIM; i += 32u) acc_o[i] *= inv_l;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Native Apple Metal does not need the Vulkan serial-store workaround.
    for (uint i = tid; i < HEAD_DIM; i += 32u) out_attn[out_base + i] = acc_o[i];
}
