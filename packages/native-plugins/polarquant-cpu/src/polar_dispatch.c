/* polar_dispatch.c - runtime dispatch to the best available SIMD path.
 *
 * The CMake build still compiles each SIMD TU only for arches whose
 * intrinsics exist (AVX2/AVX-VNNI on x86_64, NEON / dot-product on
 * AArch64) and sets POLARQUANT_HAVE_* so the dispatcher knows which
 * symbols were linked. Within a build, the actual choice is made at
 * runtime from cpuid / hwcap (see polar_cpu_features.h): an
 * AVX-VNNI-capable binary still runs correctly on an AVX2-only host.
 */

#include "polarquant/polarquant.h"
#include "polar_cpu_features.h"

#if defined(__ARM_NEON) || defined(__ARM_NEON__)
#  ifndef POLARQUANT_HAVE_NEON
#    define POLARQUANT_HAVE_NEON 1
#  endif
#endif

typedef enum {
    POLAR_SIMD_REF = 0,
    POLAR_SIMD_NEON,
    POLAR_SIMD_AVX2,
    POLAR_SIMD_AVXVNNI,
} polar_simd_t;

static polar_simd_t polar_pick(void) {
    polar_cpu_features_t f;
    polar_detect_cpu(&f);
#if defined(POLARQUANT_HAVE_AVXVNNI)
    if (f.has_avx_vnni && f.has_avx2 && f.has_fma) return POLAR_SIMD_AVXVNNI;
#endif
#if defined(POLARQUANT_HAVE_AVX2)
    if (f.has_avx2 && f.has_fma) return POLAR_SIMD_AVX2;
#endif
#if defined(POLARQUANT_HAVE_NEON)
    if (f.has_neon) return POLAR_SIMD_NEON;
#endif
    (void)f;
    return POLAR_SIMD_REF;
}

static polar_simd_t polar_simd(void) {
    static polar_simd_t cached = (polar_simd_t)-1;
    if (cached == (polar_simd_t)-1) cached = polar_pick();
    return cached;
}

void dequantize_row_q4_polar(
    const block_q4_polar * x, float * y, int64_t k, int use_qjl)
{
    switch (polar_simd()) {
#if defined(POLARQUANT_HAVE_NEON)
        case POLAR_SIMD_NEON:
            dequantize_row_q4_polar_neon(x, y, k, use_qjl); return;
#endif
#if defined(POLARQUANT_HAVE_AVX2)
        case POLAR_SIMD_AVX2:
        case POLAR_SIMD_AVXVNNI:
            dequantize_row_q4_polar_avx2(x, y, k, use_qjl); return;
#endif
        default:
            dequantize_row_q4_polar_ref(x, y, k, use_qjl); return;
    }
}

void ggml_vec_dot_q4_polar_q8_0(
    int n, float * s, const block_q4_polar * x, const struct block_q8_0 * y, int use_qjl)
{
    switch (polar_simd()) {
#if defined(POLARQUANT_HAVE_NEON)
        case POLAR_SIMD_NEON:
            ggml_vec_dot_q4_polar_q8_0_neon(n, s, x, y, use_qjl); return;
#endif
#if defined(POLARQUANT_HAVE_AVX2)
        case POLAR_SIMD_AVX2:
        case POLAR_SIMD_AVXVNNI:
            ggml_vec_dot_q4_polar_q8_0_avx2(n, s, x, y, use_qjl); return;
#endif
        default:
            ggml_vec_dot_q4_polar_q8_0_ref(n, s, x, y, use_qjl); return;
    }
}

void ggml_vec_dot_q4_polar_preht_f32(
    int n, float * s, const block_q4_polar * x, const float * q_preht, int use_qjl)
{
    switch (polar_simd()) {
#if defined(POLARQUANT_HAVE_NEON)
        case POLAR_SIMD_NEON:
            ggml_vec_dot_q4_polar_preht_f32_neon(n, s, x, q_preht, use_qjl); return;
#endif
#if defined(POLARQUANT_HAVE_AVX2)
        case POLAR_SIMD_AVX2:
        case POLAR_SIMD_AVXVNNI:
            ggml_vec_dot_q4_polar_preht_f32_avx2(n, s, x, q_preht, use_qjl); return;
#endif
        default:
            ggml_vec_dot_q4_polar_preht_f32_ref(n, s, x, q_preht, use_qjl); return;
    }
}

const char * polarquant_active_simd(void) {
    switch (polar_simd()) {
        case POLAR_SIMD_AVXVNNI: return "avxvnni";
        case POLAR_SIMD_AVX2:    return "avx2";
        case POLAR_SIMD_NEON:    return "neon";
        default:                 return "ref";
    }
}
