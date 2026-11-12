/*
 * Runtime dispatch: pick the best available SIMD path for the running CPU.
 *
 * The CMake build still compiles each SIMD TU only for arches whose
 * intrinsics exist (AVX2/AVX-VNNI on x86_64, NEON / dot-product on
 * AArch64) and sets QJL_HAVE_* so the dispatcher knows which symbols
 * were linked. Within a build, the actual choice is made at runtime
 * from cpuid / hwcap (see qjl_cpu_features.h): an AVX-VNNI-capable
 * binary still runs correctly on an AVX2-only host.
 */

#include "qjl/qjl.h"
#include "qjl_block.h"
#include "qjl_cpu_features.h"
#include <string.h>

#if defined(__ARM_NEON) || defined(__ARM_NEON__)
#  ifndef QJL_HAVE_NEON
#    define QJL_HAVE_NEON 1
#  endif
#endif

typedef enum {
    QJL_SIMD_REF = 0,
    QJL_SIMD_NEON,
    QJL_SIMD_NEON_DOTPROD,
    QJL_SIMD_AVX2,
    QJL_SIMD_AVXVNNI,
} qjl_simd_t;

static qjl_simd_t qjl_pick(void) {
    qjl_cpu_features_t f;
    qjl_detect_cpu(&f);
#if defined(QJL_HAVE_AVXVNNI)
    if (f.has_avx_vnni && f.has_avx2 && f.has_fma) return QJL_SIMD_AVXVNNI;
#endif
#if defined(QJL_HAVE_AVX2)
    if (f.has_avx2 && f.has_fma) return QJL_SIMD_AVX2;
#endif
#if defined(QJL_HAVE_NEON_DOTPROD)
    if (f.has_neon && f.has_dotprod) return QJL_SIMD_NEON_DOTPROD;
#endif
#if defined(QJL_HAVE_NEON)
    if (f.has_neon) return QJL_SIMD_NEON;
#endif
    (void)f;
    return QJL_SIMD_REF;
}

static qjl_simd_t qjl_simd(void) {
    static qjl_simd_t cached = (qjl_simd_t)-1;
    if (cached == (qjl_simd_t)-1) cached = qjl_pick();
    return cached;
}

void qjl_quantize_rows(const float *keys, const float *prj,
                       qjl_block_qjl1_256 *out, size_t n_rows) {
    switch (qjl_simd()) {
#if defined(QJL_HAVE_NEON)
        case QJL_SIMD_NEON:
        case QJL_SIMD_NEON_DOTPROD:
            qjl_quantize_rows_neon(keys, prj, out, n_rows); return;
#endif
#if defined(QJL_HAVE_AVX2)
        case QJL_SIMD_AVX2:
        case QJL_SIMD_AVXVNNI:
            qjl_quantize_rows_avx2(keys, prj, out, n_rows); return;
#endif
        default:
            qjl_quantize_rows_ref(keys, prj, out, n_rows); return;
    }
}

void qjl_score_qk(const float *q_sketch,
                  const qjl_block_qjl1_256 *packed_k,
                  int n_heads, int n_kv_heads, int n_tokens,
                  float *scores) {
    switch (qjl_simd()) {
#if defined(QJL_HAVE_NEON)
        case QJL_SIMD_NEON:
        case QJL_SIMD_NEON_DOTPROD:
            qjl_score_qk_neon(q_sketch, packed_k, n_heads, n_kv_heads, n_tokens, scores);
            return;
#endif
#if defined(QJL_HAVE_AVX2)
        case QJL_SIMD_AVX2:
        case QJL_SIMD_AVXVNNI:
            qjl_score_qk_avx2(q_sketch, packed_k, n_heads, n_kv_heads, n_tokens, scores);
            return;
#endif
        default:
            qjl_score_qk_ref(q_sketch, packed_k, n_heads, n_kv_heads, n_tokens, scores);
            return;
    }
}

void qjl_score_qk_i8(const qjl_i8_sketch_256 *q_sketch_i8,
                     const qjl_block_qjl1_256 *packed_k,
                     int n_heads, int n_kv_heads, int n_tokens,
                     float *scores) {
    switch (qjl_simd()) {
#if defined(QJL_HAVE_AVXVNNI)
        case QJL_SIMD_AVXVNNI:
            qjl_score_qk_i8_avxvnni(q_sketch_i8, packed_k, n_heads, n_kv_heads, n_tokens, scores);
            return;
#endif
#if defined(QJL_HAVE_NEON_DOTPROD)
        case QJL_SIMD_NEON_DOTPROD:
            qjl_score_qk_i8_dotprod(q_sketch_i8, packed_k, n_heads, n_kv_heads, n_tokens, scores);
            return;
#endif
        default:
            qjl_score_qk_i8_ref(q_sketch_i8, packed_k, n_heads, n_kv_heads, n_tokens, scores);
            return;
    }
}

const char *qjl_active_simd(void) {
    switch (qjl_simd()) {
        case QJL_SIMD_AVXVNNI:      return "avxvnni";
        case QJL_SIMD_AVX2:         return "avx2";
        case QJL_SIMD_NEON_DOTPROD: return "neon-dotprod";
        case QJL_SIMD_NEON:         return "neon";
        default:                    return "ref";
    }
}
