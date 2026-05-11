// AUTHORED — hardware-verify pending (no NVIDIA HW on the authoring machine;
// run verify/cuda_runner.sh on a CUDA host).
//
// Fused attention CUDA kernel: QJL-K score + TBQ3-V mix, online softmax that
// never materializes the per-token score vector. Production translation of the
// fixture-parity harness fused_attn_qjl_tbq3_kernel in
// packages/inference/verify/cuda_verify.cu — warp-cooperative (32 lanes), online
// flash-attention softmax, TCQ-less TBQ3 V decode (codebook lookup * d ->
// Hadamard-32 -> ±1 sign uncondition), one CUDA block per (q_head, q_pos).
// Bit-faithful to the CPU op GGML_OP_FUSED_ATTN_QJL_TBQ (ggml-cpu/fused-attn-qjl-tbq.c)
// and the C reference eliza_fused_attn_qjl_tbq3 in
// packages/inference/verify/qjl_polar_ref.c; the standalone path is the
// hardware-verified Vulkan port vulkan/fused_attn_qjl_tbq.comp + the Metal mirror
// metal/fused_attn_qjl_tbq.metal.
//
// Plus a DP4A int8-sketch QJL score path (qjl_score_dp4a_kernel) — the 256-dim
// sign-dot becomes 64 __dp4a MACs (Pascal+); the #else keeps it correct on
// older arches. Same accuracy as the fp32 score up to the q int8 round-trip.
//
// Mirror this into the fork at ggml/src/ggml-cuda/fused-attn-qjl-tbq.cu via the
// kernel-patches hook; build with -DGGML_CUDA_FUSED_ATTN_QJL=ON. The CMake glob
// in ggml-cuda/CMakeLists.txt (`file(GLOB GGML_SOURCES_CUDA "*.cu")`) picks it
// up unconditionally; the body is gated by GGML_CUDA_FUSED_ATTN_QJL so a no-flag
// build still produces an empty object file. fused_attn is an optimization on
// top of the five required kernels (AGENTS.md §3), not a required kernel — the
// build-script required-kernel gate does NOT include it.

#include "ggml.h"
#include "ggml-impl.h"
#include "common.cuh"

#if defined(GGML_CUDA_FUSED_ATTN_QJL)

#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <cstdint>
#include <cmath>
#include <cstring>

#define FUSED_PROJ_DIM   QK_QJL          // 256
#define FUSED_HEAD_DIM   128
#define FUSED_TBQ_BLK    QK_TBQ          // 32
#define FUSED_TBQ_PER_TOKEN (FUSED_HEAD_DIM / FUSED_TBQ_BLK)   // 4
#define FUSED_WARP       32

// sqrt(pi/2) — locked to the QJL/CPU reference.
#define FUSED_QJL_SQRT_PI_OVER_2 1.2533141373155003f

// bf16 pattern (uint16) -> fp32. Matches qjl_bf16_to_fp32 in the CPU shim.
static __device__ __forceinline__ float fused_bf16_to_fp32(uint16_t bits) {
    uint32_t u = ((uint32_t) bits) << 16;
    float f; memcpy(&f, &u, sizeof(f)); return f;
}
static __device__ __forceinline__ float fused_fp16_to_fp32(uint16_t bits) {
    return __half2float(__ushort_as_half(bits));
}

// TBQ3 codebook (8 centroids) — bit-identical to ELIZA_TBQ3_CODEBOOK / the fork.
__constant__ float k_fused_tbq3_codebook[8] = {
    -2.1519457f, -1.3439093f, -0.7560053f, -0.2450942f,
     0.2450942f,  0.7560053f,  1.3439093f,  2.1519457f,
};
// Fixed ±1 sign vector for the TBQ uncondition step (ELIZA_TBQ_SIGNS_32_FORK).
__constant__ int8_t k_fused_tbq_signs_32[32] = {
     1, -1,  1,  1, -1,  1, -1, -1,
     1,  1, -1,  1, -1, -1,  1, -1,
    -1,  1,  1, -1,  1, -1, -1,  1,
     1, -1,  1, -1, -1,  1, -1,  1,
};

static __device__ __forceinline__ uint8_t fused_tbq3_get_code(const uint8_t * qs, int idx) {
    const int bit = idx * 3, byte = bit >> 3, shift = bit & 7;
    uint32_t bits = (uint32_t) qs[byte] >> shift;
    if (shift > 5 && byte + 1 < 12) bits |= (uint32_t) qs[byte + 1] << (8 - shift);
    return (uint8_t)(bits & 0x7u);
}
static __device__ __forceinline__ void fused_hadamard32(float * x) {
    for (int len = 1; len < 32; len <<= 1) {
        for (int i = 0; i < 32; i += 2 * len) {
            for (int j = 0; j < len; ++j) {
                const float a = x[i + j], b = x[i + j + len];
                x[i + j] = a + b; x[i + j + len] = a - b;
            }
        }
    }
    const float n = 0.1767766952966369f;   // 1/sqrt(32)
    for (int i = 0; i < 32; ++i) x[i] *= n;
}
// Decode one block_tbq3_0 into 32 unconditioned (real head-dim) V values.
static __device__ __forceinline__ void fused_tbq3_decode_block_uncond(const block_tbq3_0 & blk, float * out32) {
    const float d = fused_fp16_to_fp32(blk.d);
    if (d == 0.0f) { for (int i = 0; i < 32; ++i) out32[i] = 0.0f; return; }
    for (int i = 0; i < 32; ++i) out32[i] = d * k_fused_tbq3_codebook[fused_tbq3_get_code(blk.qs, i)];
    fused_hadamard32(out32);
    for (int i = 0; i < 32; ++i) out32[i] *= (float) k_fused_tbq_signs_32[i];
}

// One CUDA block per (q_head, q_pos); 32 lanes. Lane `tid` owns byte `tid` of
// the 32-byte QJL sign vector and 8 of the 256 sketch elements. Each lane keeps
// 4 of the 128 head-dim accumulator slots (4 chunks of 32, lane owns slot tid
// within each chunk).
//
//   q_sketch F32       [n_q_pos, n_heads, proj_dim]   (already projected Π·q)
//   k_blocks QJL1_256  [n_kv_heads, n_kv]             (token-major, 34 B/block)
//   v_blocks TBQ3_0    [n_kv_heads, n_kv, 4]          (token-major, 4 x 14 B)
//   out      F32       [n_q_pos, n_heads, 128]
//
// `kv_tile` (>0) walks the KV range in tiles for cancellation granularity; the
// running (m, l, acc) state is per-block (registers + shared), so the result is
// identical to a single-tile pass — the tiling is purely a scheduler hook.
__global__ void fused_attn_qjl_tbq3_kernel(
        const float * __restrict__ q_sketch,
        const block_qjl1_256 * __restrict__ k_blocks,
        const block_tbq3_0 * __restrict__ v_blocks,
        int proj_dim, int n_heads, int n_kv_heads, int n_q_pos, int n_kv,
        float sm_scale, int kv_tile, float * __restrict__ out) {
    const int lane  = threadIdx.x;                 // 0..31
    const int hq    = blockIdx.x;
    const int q_pos = blockIdx.y;
    if (hq >= n_heads || q_pos >= n_q_pos || lane >= FUSED_WARP) return;
    const int gqa = n_heads / n_kv_heads;
    const int hk  = hq / gqa;
    const float * qh = q_sketch + ((size_t) q_pos * n_heads + hq) * proj_dim;
    const block_qjl1_256 * pk = k_blocks + (size_t) hk * n_kv;
    const block_tbq3_0   * pv = v_blocks + (size_t) hk * n_kv * FUSED_TBQ_PER_TOKEN;
    float * oh = out + ((size_t) q_pos * n_heads + hq) * FUSED_HEAD_DIM;

    const float qjl_scl = FUSED_QJL_SQRT_PI_OVER_2 / (float) proj_dim;

    // Each lane keeps acc[c] for chunk c at element (c*32 + lane).
    float acc[FUSED_TBQ_PER_TOKEN];
    #pragma unroll
    for (int c = 0; c < FUSED_TBQ_PER_TOKEN; ++c) acc[c] = 0.0f;
    float m = -INFINITY, l = 0.0f;

    const int tile = (kv_tile > 0) ? kv_tile : n_kv;
    for (int t0 = 0; t0 < n_kv; t0 += tile) {
        const int t1 = (t0 + tile < n_kv) ? (t0 + tile) : n_kv;
        for (int t = t0; t < t1; ++t) {
            // --- QJL K score: lane owns byte `lane` (8 sign bits / 8 sketch dims). ---
            const uint8_t sb = pk[t].signs[lane];
            float partial = 0.0f;
            #pragma unroll
            for (int b = 0; b < 8; ++b) {
                const float qv = qh[lane * 8 + b];
                partial += ((sb >> b) & 1) ? qv : -qv;
            }
            #pragma unroll
            for (int off = 16; off > 0; off >>= 1)
                partial += __shfl_xor_sync(0xFFFFFFFFu, partial, off);
            const float score = qjl_scl * fused_bf16_to_fp32(pk[t].d) * partial * sm_scale;

            // --- online softmax update (every lane has the same `score`). ---
            const float m_new = fmaxf(m, score);
            const float corr  = __expf(m - m_new);
            const float w     = __expf(score - m_new);
            l = l * corr + w;

            // --- V decode + mix. Lane decodes block `lane>>3` only if lane<? ---
            // Simpler & matches the reference: each lane decodes ALL 4 chunks but
            // only takes its own element. The reference does the same work per
            // head; head_dim=128 fits in registers. (A future optimization can
            // split the 4 chunks across 8-lane groups; keep parity simple here.)
            #pragma unroll
            for (int c = 0; c < FUSED_TBQ_PER_TOKEN; ++c) {
                float dec[32];
                fused_tbq3_decode_block_uncond(pv[(size_t) t * FUSED_TBQ_PER_TOKEN + c], dec);
                acc[c] = acc[c] * corr + w * dec[lane];
            }
            m = m_new;
        }
    }
    const float inv_l = (l > 0.0f) ? (1.0f / l) : 0.0f;
    #pragma unroll
    for (int c = 0; c < FUSED_TBQ_PER_TOKEN; ++c) oh[c * 32 + lane] = acc[c] * inv_l;
}

// --------------------------- DP4A int8-QJL score ---------------------------
// score[h,t] = (sqrt(pi/2)/proj_dim) * ||k_t|| * q_scale[h]
//            * Σ_w __dp4a(q_i8_pack[w], k_sign_pack[w])
// Caller quantizes the fp32 q_sketch to int8 with q_scale[h] = max|q_h| / 127.
__global__ void qjl_score_dp4a_kernel(
        const int8_t * __restrict__ q_sketch_i8,
        const float  * __restrict__ q_scale,
        const block_qjl1_256 * __restrict__ packed_k,
        int proj_dim, int n_heads, int n_kv_heads, int n_kv_tokens,
        float * __restrict__ scores) {
    const int out = blockIdx.x;
    if (out >= n_heads * n_kv_tokens) return;
    const int hq = out / n_kv_tokens;
    const int t  = out % n_kv_tokens;
    const int gqa = n_heads / n_kv_heads;
    const int hk  = hq / gqa;
    const int8_t * qi8 = q_sketch_i8 + (size_t) hq * proj_dim;
    const block_qjl1_256 & blk = packed_k[(size_t) hk * n_kv_tokens + t];

    int partial = 0;
    for (int w = threadIdx.x; w < proj_dim / 4; w += blockDim.x) {
        const int byte_idx = w >> 1;
        const uint8_t sb = (uint8_t)(blk.signs[byte_idx] >> ((w & 1) * 4));
        int kpack = 0;
        #pragma unroll
        for (int b = 0; b < 4; ++b) {
            const int8_t s = ((sb >> b) & 1) ? (int8_t) 1 : (int8_t) -1;
            kpack |= ((int)(uint8_t) s) << (b * 8);
        }
        int qpack;
        memcpy(&qpack, qi8 + w * 4, 4);
#if defined(__CUDA_ARCH__) && __CUDA_ARCH__ >= 610
        partial = __dp4a(qpack, kpack, partial);
#else
        #pragma unroll
        for (int b = 0; b < 4; ++b) {
            const int8_t qa = (int8_t)((qpack >> (b * 8)) & 0xff);
            const int8_t ka = (int8_t)((kpack >> (b * 8)) & 0xff);
            partial += (int) qa * (int) ka;
        }
#endif
    }
    #pragma unroll
    for (int off = 16; off > 0; off >>= 1)
        partial += __shfl_down_sync(0xFFFFFFFFu, partial, off);
    if (threadIdx.x == 0) {
        const float scl = FUSED_QJL_SQRT_PI_OVER_2 / (float) proj_dim;
        scores[out] = scl * fused_bf16_to_fp32(blk.d) * (float) partial * q_scale[hq];
    }
}

// ----------------------------- launch wrappers -----------------------------

extern "C" void fused_attn_qjl_tbq_cuda(
        const float * q_sketch_d,             // [n_q_pos, n_heads, proj_dim] fp32
        const void  * packed_k_d,             // block_qjl1_256 [n_kv_heads, n_kv]
        const void  * packed_v_d,             // block_tbq3_0  [n_kv_heads, n_kv, 4]
        int n_heads, int n_kv_heads, int n_q_pos, int n_kv,
        float sm_scale, int kv_tile,
        float * out_d,                        // [n_q_pos, n_heads, 128] fp32
        cudaStream_t stream) {
    GGML_ASSERT(n_heads > 0 && n_kv_heads > 0 && n_q_pos > 0 && n_kv > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    const dim3 grid(n_heads, n_q_pos, 1);
    fused_attn_qjl_tbq3_kernel<<<grid, FUSED_WARP, 0, stream>>>(
        q_sketch_d,
        (const block_qjl1_256 *) packed_k_d,
        (const block_tbq3_0   *) packed_v_d,
        FUSED_PROJ_DIM, n_heads, n_kv_heads, n_q_pos, n_kv, sm_scale, kv_tile, out_d);
}

extern "C" void qjl_score_dp4a_cuda(
        const int8_t * q_sketch_i8_d,         // [n_heads, proj_dim] int8
        const float  * q_scale_d,             // [n_heads] fp32
        const void   * packed_k_d,            // block_qjl1_256 [n_kv_heads, n_kv]
        int n_heads, int n_kv_heads, int n_kv_tokens,
        float * scores_d,                     // [n_heads, n_kv_tokens] fp32
        cudaStream_t stream) {
    GGML_ASSERT(n_heads > 0 && n_kv_heads > 0 && n_kv_tokens > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    qjl_score_dp4a_kernel<<<n_heads * n_kv_tokens, FUSED_WARP, 0, stream>>>(
        q_sketch_i8_d, q_scale_d, (const block_qjl1_256 *) packed_k_d,
        FUSED_PROJ_DIM, n_heads, n_kv_heads, n_kv_tokens, scores_d);
}

#endif // GGML_CUDA_FUSED_ATTN_QJL
