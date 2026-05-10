/*
 * Runtime dispatch: pick the best available SIMD path.
 * The CMake build sets QJL_HAVE_AVX2 / QJL_HAVE_NEON when the matching
 * SIMD TUs are part of the static library. NEON is baseline on AArch64
 * so the NEON dispatch is also enabled by __ARM_NEON when the
 * dispatcher TU is itself built for AArch64.
 */

#include "qjl/qjl.h"
#include "qjl_block.h"
#include <string.h>

#if defined(__ARM_NEON) || defined(__ARM_NEON__)
#  ifndef QJL_HAVE_NEON
#    define QJL_HAVE_NEON 1
#  endif
#endif

void qjl_quantize_rows(const float *keys, const float *prj,
                       qjl_block_qjl1_256 *out, size_t n_rows) {
#if defined(QJL_HAVE_NEON)
    qjl_quantize_rows_neon(keys, prj, out, n_rows);
#elif defined(QJL_HAVE_AVX2)
    qjl_quantize_rows_avx2(keys, prj, out, n_rows);
#else
    qjl_quantize_rows_ref(keys, prj, out, n_rows);
#endif
}

void qjl_score_qk(const float *q_sketch,
                  const qjl_block_qjl1_256 *packed_k,
                  int n_heads, int n_kv_heads, int n_tokens,
                  float *scores) {
#if defined(QJL_HAVE_NEON)
    qjl_score_qk_neon(q_sketch, packed_k, n_heads, n_kv_heads, n_tokens, scores);
#elif defined(QJL_HAVE_AVX2)
    qjl_score_qk_avx2(q_sketch, packed_k, n_heads, n_kv_heads, n_tokens, scores);
#else
    qjl_score_qk_ref(q_sketch, packed_k, n_heads, n_kv_heads, n_tokens, scores);
#endif
}

const char *qjl_active_simd(void) {
#if defined(QJL_HAVE_NEON)
    return "neon";
#elif defined(QJL_HAVE_AVX2)
    return "avx2";
#else
    return "ref";
#endif
}
