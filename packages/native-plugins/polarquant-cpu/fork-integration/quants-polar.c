// quants-polar.c - PolarQuant Q4 weight quant: scalar + AVX2 + NEON.
//
// Behavioural source of truth: the standalone reference library at
//   packages/native-plugins/polarquant-cpu/   (in the milady repo)
// which carries the unit tests + SIMD-vs-scalar parity gates.  This
// TU is the in-fork transcription that compiles into libggml-cpu.so.
//
// Block layout (`block_q4_polar` in ggml-common.h):
//   ggml_fp16_t d                     2 bytes  (per-block L2 norm)
//   uint8_t qs[QK_POLAR / 2]         64 bytes  (4-bit codes, 2/byte)
//   uint8_t qjl[QK_POLAR / 8]        16 bytes  (1-bit residual sign per coord;
//                                                bit 0 of qjl[0] is the global
//                                                +/-1 sign in this writer)
//
// Algorithm (mirrors PolarQuant arXiv:2603.29078):
//   encode:  L2-normalise -> Walsh-Hadamard rotate -> bucketize against
//            16 Lloyd-Max centroids on N(0, 1) -> pack 4-bit codes ->
//            optional 1-bit QJL residual sign.
//   decode:  unpack centroid LUT -> apply QJL sign correction ->
//            inverse Walsh-Hadamard -> rescale by L2 norm / QK_POLAR.
//
// QJL is **on by default** in this in-fork TU because the GGUF
// converter at scripts/polarquant_to_gguf.py only ever emits Q4_POLAR
// tensors with the QJL bits populated.  If a future converter wants
// the no-QJL variant it should bump a metadata key in the GGUF and
// the type-traits hookup will branch on that.
#include "quants-polar.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

#ifndef QK8_0
#  define QK8_0 32
#endif

#define POLAR_QJL_CORRECTION_MAGNITUDE 0.5f
#define POLAR_QJL_SEED                 42u

// 16 Lloyd-Max centroids for X ~ N(0, 1), 100-iter convergence.
// Bit-exact match against
//   packages/native-plugins/polarquant-cpu/scripts/gen_centroids.py
// which mirrors
//   packages/training/scripts/quantization/polarquant/polar_quant.py
//   ::_compute_lloyd_max_centroids(n_levels=16, n_iter=100)
static const float POLAR_Q4_CENTROIDS[16] = {
    -2.754354807e+00f, -2.093562707e+00f, -1.643041510e+00f, -1.279739752e+00f,
    -9.626409783e-01f, -6.723921169e-01f, -3.978971029e-01f, -1.317577823e-01f,
     1.317577823e-01f,  3.978971029e-01f,  6.723921169e-01f,  9.626409783e-01f,
     1.279739752e+00f,  1.643041510e+00f,  2.093562707e+00f,  2.754354807e+00f,
};
// Voronoi cell boundaries (15 internal cuts) — used for O(N) bucketize.
static const float POLAR_Q4_BOUNDARIES[15] = {
    -2.423958757e+00f, -1.868302108e+00f, -1.461390631e+00f, -1.121190365e+00f,
    -8.175165476e-01f, -5.351446099e-01f, -2.648274426e-01f,  4.996003611e-16f,
     2.648274426e-01f,  5.351446099e-01f,  8.175165476e-01f,  1.121190365e+00f,
     1.461390631e+00f,  1.868302108e+00f,  2.423958757e+00f,
};

// Deterministic xorshift32 +/-1 sign vector for the QJL residual.
// Encoder + decoder must agree byte-for-byte; the converter writes
// the same xorshift32 sequence into the GGUF (or recomputes it on
// load — both sides land at the same 128 bits).
static void polar_qjl_signs(float * out) {
    uint32_t s = POLAR_QJL_SEED;
    if (s == 0u) s = 1u;
    for (int i = 0; i < QK_POLAR; i++) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s <<  5;
        out[i] = (s & 1u) ? 1.0f : -1.0f;
    }
}

// In-place size-128 Walsh-Hadamard butterfly.  Self-inverse up to
// scaling by 1/sqrt(QK_POLAR), which we fold into the per-block norm
// scale on the decode side.
static void polar_hadamard_inplace(float * x) {
    for (int h = 1; h < QK_POLAR; h <<= 1) {
        for (int i = 0; i < QK_POLAR; i += (h << 1)) {
            for (int j = i; j < i + h; j++) {
                const float a = x[j];
                const float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
}

// ---------- encoder (scalar; convert-time, not hot path) ----------

static inline uint8_t polar_q4_bucketize(float v) {
    uint8_t code = 0;
    for (int i = 0; i < 15; i++) {
        if (v > POLAR_Q4_BOUNDARIES[i]) code = (uint8_t)(i + 1);
    }
    return code;
}

void quantize_row_q4_polar_ref(const float * x, void * vy, int64_t k) {
    if (k <= 0 || (k % QK_POLAR) != 0) return;
    block_q4_polar * y = (block_q4_polar *)vy;
    const int64_t nb = k / QK_POLAR;

    float qjl_signs[QK_POLAR];
    polar_qjl_signs(qjl_signs);

    for (int64_t b = 0; b < nb; b++) {
        const float * src = x + b * QK_POLAR;
        block_q4_polar * dst = y + b;

        double sumsq = 0.0;
        for (int i = 0; i < QK_POLAR; i++) sumsq += (double)src[i] * (double)src[i];
        const float l2 = (float)sqrt(sumsq);
        const float inv_l2 = (l2 > 1e-10f) ? (1.0f / l2) : 0.0f;
        dst->d = GGML_FP32_TO_FP16(l2);

        float buf[QK_POLAR];
        for (int i = 0; i < QK_POLAR; i++) buf[i] = src[i] * inv_l2;
        polar_hadamard_inplace(buf);

        uint8_t codes[QK_POLAR];
        for (int i = 0; i < QK_POLAR; i++) codes[i] = polar_q4_bucketize(buf[i]);
        for (int i = 0; i < QK_POLAR / 2; i++) {
            const uint8_t lo = codes[2 * i];
            const uint8_t hi = codes[2 * i + 1];
            dst->qs[i] = (uint8_t)((hi << 4) | (lo & 0x0F));
        }

        // QJL residual: project (block - centroids) onto sign vector;
        // store sign of projection in bit 0 of qjl[0].
        float proj = 0.0f;
        for (int i = 0; i < QK_POLAR; i++) {
            const float c = POLAR_Q4_CENTROIDS[codes[i]];
            proj += (buf[i] - c) * qjl_signs[i];
        }
        memset(dst->qjl, 0, QK_POLAR / 8);
        dst->qjl[0] = (uint8_t)((proj >= 0.0f) ? 1 : 0);
    }
}

void quantize_row_q4_polar(const float * x, void * y, int64_t k) {
    quantize_row_q4_polar_ref(x, y, k);
}

// ---------- decoder ----------

static inline void polar_unpack_centroids(const uint8_t * qs, float * dst) {
    for (int i = 0; i < QK_POLAR / 2; i++) {
        const uint8_t byte = qs[i];
        dst[2 * i]     = POLAR_Q4_CENTROIDS[byte & 0x0F];
        dst[2 * i + 1] = POLAR_Q4_CENTROIDS[(byte >> 4) & 0x0F];
    }
}

#if defined(__AVX2__)

#include <immintrin.h>

static inline void polar_hadamard_avx2(float * x) {
    // Stages h=1, h=2, h=4: intra-ymm via shuffle + XOR-sign + add.
    for (int v = 0; v < QK_POLAR; v += 8) {
        __m256 a = _mm256_loadu_ps(x + v);
        // h=1
        {
            __m256 b   = _mm256_shuffle_ps(a, a, _MM_SHUFFLE(2, 3, 0, 1));
            __m256 sgn = _mm256_castsi256_ps(_mm256_setr_epi32(
                0, (int)0x80000000, 0, (int)0x80000000,
                0, (int)0x80000000, 0, (int)0x80000000));
            a = _mm256_add_ps(_mm256_xor_ps(a, sgn), b);
        }
        // h=2
        {
            __m256 b   = _mm256_shuffle_ps(a, a, _MM_SHUFFLE(1, 0, 3, 2));
            __m256 sgn = _mm256_castsi256_ps(_mm256_setr_epi32(
                0, 0, (int)0x80000000, (int)0x80000000,
                0, 0, (int)0x80000000, (int)0x80000000));
            a = _mm256_add_ps(_mm256_xor_ps(a, sgn), b);
        }
        // h=4
        {
            __m256 b   = _mm256_permute2f128_ps(a, a, 0x01);
            __m256 sgn = _mm256_castsi256_ps(_mm256_setr_epi32(
                0, 0, 0, 0,
                (int)0x80000000, (int)0x80000000, (int)0x80000000, (int)0x80000000));
            a = _mm256_add_ps(_mm256_xor_ps(a, sgn), b);
        }
        _mm256_storeu_ps(x + v, a);
    }
    // Stages h=8, 16, 32, 64: cross-vector add/sub.
    for (int g = 0; g < QK_POLAR; g += 16) {
        __m256 a = _mm256_loadu_ps(x + g);
        __m256 b = _mm256_loadu_ps(x + g + 8);
        _mm256_storeu_ps(x + g,     _mm256_add_ps(a, b));
        _mm256_storeu_ps(x + g + 8, _mm256_sub_ps(a, b));
    }
    for (int g = 0; g < QK_POLAR; g += 32) {
        for (int j = 0; j < 16; j += 8) {
            __m256 a = _mm256_loadu_ps(x + g + j);
            __m256 b = _mm256_loadu_ps(x + g + j + 16);
            _mm256_storeu_ps(x + g + j,      _mm256_add_ps(a, b));
            _mm256_storeu_ps(x + g + j + 16, _mm256_sub_ps(a, b));
        }
    }
    for (int g = 0; g < QK_POLAR; g += 64) {
        for (int j = 0; j < 32; j += 8) {
            __m256 a = _mm256_loadu_ps(x + g + j);
            __m256 b = _mm256_loadu_ps(x + g + j + 32);
            _mm256_storeu_ps(x + g + j,      _mm256_add_ps(a, b));
            _mm256_storeu_ps(x + g + j + 32, _mm256_sub_ps(a, b));
        }
    }
    for (int j = 0; j < 64; j += 8) {
        __m256 a = _mm256_loadu_ps(x + j);
        __m256 b = _mm256_loadu_ps(x + j + 64);
        _mm256_storeu_ps(x + j,      _mm256_add_ps(a, b));
        _mm256_storeu_ps(x + j + 64, _mm256_sub_ps(a, b));
    }
}

#endif // __AVX2__

#if defined(__ARM_NEON) || defined(__ARM_NEON__)

#include <arm_neon.h>

static inline float32x4_t polar_hadamard_q_h1_h2_neon(float32x4_t a) {
    float32x4_t partner = vrev64q_f32(a);
    static const uint32_t sgn_h1_arr[4] = {0u, 0x80000000u, 0u, 0x80000000u};
    uint32x4_t sgn_h1 = vld1q_u32(sgn_h1_arr);
    float32x4_t a1 = vreinterpretq_f32_u32(
        veorq_u32(vreinterpretq_u32_f32(a), sgn_h1));
    float32x4_t b = vaddq_f32(a1, partner);

    float32x4_t partner2 = vextq_f32(b, b, 2);
    static const uint32_t sgn_h2_arr[4] = {0u, 0u, 0x80000000u, 0x80000000u};
    uint32x4_t sgn_h2 = vld1q_u32(sgn_h2_arr);
    float32x4_t b1 = vreinterpretq_f32_u32(
        veorq_u32(vreinterpretq_u32_f32(b), sgn_h2));
    return vaddq_f32(b1, partner2);
}

static inline void polar_hadamard_neon(float * x) {
    for (int v = 0; v < QK_POLAR; v += 4) {
        vst1q_f32(x + v, polar_hadamard_q_h1_h2_neon(vld1q_f32(x + v)));
    }
    for (int g = 0; g < QK_POLAR; g += 8) {
        float32x4_t a = vld1q_f32(x + g);
        float32x4_t b = vld1q_f32(x + g + 4);
        vst1q_f32(x + g,     vaddq_f32(a, b));
        vst1q_f32(x + g + 4, vsubq_f32(a, b));
    }
    for (int g = 0; g < QK_POLAR; g += 16) {
        for (int j = 0; j < 8; j += 4) {
            float32x4_t a = vld1q_f32(x + g + j);
            float32x4_t b = vld1q_f32(x + g + j + 8);
            vst1q_f32(x + g + j,     vaddq_f32(a, b));
            vst1q_f32(x + g + j + 8, vsubq_f32(a, b));
        }
    }
    for (int g = 0; g < QK_POLAR; g += 32) {
        for (int j = 0; j < 16; j += 4) {
            float32x4_t a = vld1q_f32(x + g + j);
            float32x4_t b = vld1q_f32(x + g + j + 16);
            vst1q_f32(x + g + j,      vaddq_f32(a, b));
            vst1q_f32(x + g + j + 16, vsubq_f32(a, b));
        }
    }
    for (int g = 0; g < QK_POLAR; g += 64) {
        for (int j = 0; j < 32; j += 4) {
            float32x4_t a = vld1q_f32(x + g + j);
            float32x4_t b = vld1q_f32(x + g + j + 32);
            vst1q_f32(x + g + j,      vaddq_f32(a, b));
            vst1q_f32(x + g + j + 32, vsubq_f32(a, b));
        }
    }
    for (int j = 0; j < 64; j += 4) {
        float32x4_t a = vld1q_f32(x + j);
        float32x4_t b = vld1q_f32(x + j + 64);
        vst1q_f32(x + j,      vaddq_f32(a, b));
        vst1q_f32(x + j + 64, vsubq_f32(a, b));
    }
}

#endif // __ARM_NEON

void dequantize_row_q4_polar(const block_q4_polar * x, float * y, int64_t k) {
    if (k <= 0 || (k % QK_POLAR) != 0) return;
    const int64_t nb = k / QK_POLAR;

    float qjl_signs[QK_POLAR];
    polar_qjl_signs(qjl_signs);
    const float inv_d = 1.0f / (float)QK_POLAR;
    const float qjl_mag = POLAR_QJL_CORRECTION_MAGNITUDE / sqrtf((float)QK_POLAR);

    for (int64_t b = 0; b < nb; b++) {
        const block_q4_polar * src = x + b;
        float * dst = y + b * QK_POLAR;

        const float l2 = GGML_FP16_TO_FP32(src->d);
        const float scale = inv_d * l2;

        float buf[QK_POLAR];
        polar_unpack_centroids(src->qs, buf);

        const uint8_t bit  = (uint8_t)(src->qjl[0] & 1u);
        const float   sign = bit ? 1.0f : -1.0f;
        const float   sm   = sign * qjl_mag;
        for (int i = 0; i < QK_POLAR; i++) {
            buf[i] += sm * qjl_signs[i];
        }

#if defined(__AVX2__)
        polar_hadamard_avx2(buf);
#elif defined(__ARM_NEON) || defined(__ARM_NEON__)
        polar_hadamard_neon(buf);
#else
        polar_hadamard_inplace(buf);
#endif

        for (int i = 0; i < QK_POLAR; i++) {
            dst[i] = buf[i] * scale;
        }
    }
}

// ---------- dot product against Q8_0 ----------

void ggml_vec_dot_q4_polar_q8_0(int n, float * s, size_t bs,
                                const void * vx, size_t bx,
                                const void * vy, size_t by, int nrc)
{
    (void)bs; (void)bx; (void)by; (void)nrc;
    *s = 0.0f;
    if (n <= 0 || (n % QK_POLAR) != 0) return;

    const block_q4_polar * x = (const block_q4_polar *)vx;
    const block_q8_0     * y = (const block_q8_0     *)vy;

    const int nb_polar = n / QK_POLAR;
    const int n_q8_per_polar = QK_POLAR / QK8_0; // 4

    float buf[QK_POLAR];
    double acc = 0.0;

    for (int b = 0; b < nb_polar; b++) {
        dequantize_row_q4_polar(x + b, buf, QK_POLAR);

        for (int qb = 0; qb < n_q8_per_polar; qb++) {
            const block_q8_0 * yb = y + b * n_q8_per_polar + qb;
            const float scale = GGML_FP16_TO_FP32(yb->d);
            const float * xchunk = buf + qb * QK8_0;

            float local = 0.0f;
            for (int i = 0; i < QK8_0; i++) {
                local += xchunk[i] * (float)yb->qs[i];
            }
            acc += (double)scale * (double)local;
        }
    }

    *s = (float)acc;
}
