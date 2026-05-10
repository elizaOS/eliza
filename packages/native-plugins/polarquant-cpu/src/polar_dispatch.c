/* polar_dispatch.c - compile-time dispatch to the best available SIMD path.
 *
 * The CMake build sets POLARQUANT_HAVE_AVX2 / POLARQUANT_HAVE_NEON when
 * the matching SIMD TUs are part of the static library.  NEON is
 * baseline on AArch64, so the NEON dispatch is also enabled by
 * __ARM_NEON when the dispatcher TU is itself built for AArch64.  AVX2
 * needs the build-system flag because the AVX2 TU itself only opts in
 * via -mavx2; the dispatcher TU compiles without -mavx2.
 */

#include "polarquant/polarquant.h"

#if defined(__ARM_NEON) || defined(__ARM_NEON__)
#  ifndef POLARQUANT_HAVE_NEON
#    define POLARQUANT_HAVE_NEON 1
#  endif
#endif

void dequantize_row_q4_polar(
    const block_q4_polar * x,
    float * y,
    int64_t k,
    int use_qjl)
{
#if defined(POLARQUANT_HAVE_NEON)
    dequantize_row_q4_polar_neon(x, y, k, use_qjl);
#elif defined(POLARQUANT_HAVE_AVX2)
    dequantize_row_q4_polar_avx2(x, y, k, use_qjl);
#else
    dequantize_row_q4_polar_ref(x, y, k, use_qjl);
#endif
}

void ggml_vec_dot_q4_polar_q8_0(
    int n,
    float * s,
    const block_q4_polar * x,
    const struct block_q8_0 * y,
    int use_qjl)
{
#if defined(POLARQUANT_HAVE_NEON)
    ggml_vec_dot_q4_polar_q8_0_neon(n, s, x, y, use_qjl);
#elif defined(POLARQUANT_HAVE_AVX2)
    ggml_vec_dot_q4_polar_q8_0_avx2(n, s, x, y, use_qjl);
#else
    ggml_vec_dot_q4_polar_q8_0_ref(n, s, x, y, use_qjl);
#endif
}

const char * polarquant_active_simd(void) {
#if defined(POLARQUANT_HAVE_NEON)
    return "neon";
#elif defined(POLARQUANT_HAVE_AVX2)
    return "avx2";
#else
    return "ref";
#endif
}
