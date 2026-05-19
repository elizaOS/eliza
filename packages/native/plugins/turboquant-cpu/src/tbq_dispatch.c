/* tbq_dispatch.c - runtime dispatch to the best available SIMD path.
 *
 * The CMake build still compiles each SIMD TU only for arches whose
 * intrinsics exist (AVX2 on x86_64, NEON on AArch64, RVV 1.0 on
 * riscv64) and sets TBQ_HAVE_* so the dispatcher knows which symbols
 * were linked. Within a build, the actual choice is made at runtime
 * from cpuid / hwcap / hwprobe (see tbq_cpu_features.h).
 *
 * Today only the scalar reference and the riscv64 RVV intrinsic
 * kernels exist. The dispatch table is wired with all four lanes so
 * NEON / AVX2 sister implementations can slot in later without any
 * change to call sites.
 */

#include "turboquant/turboquant.h"
#include "tbq_cpu_features.h"

#include <stdlib.h>
#include <string.h>

typedef void (*tbq_q3_fn)(const float src[32], tbq_block_tbq3_0 * dst);
typedef void (*tbq_q4_fn)(const float src[32], tbq_block_tbq4_0 * dst);
typedef void (*tbq_d3_fn)(const tbq_block_tbq3_0 * src, float dst[32]);
typedef void (*tbq_d4_fn)(const tbq_block_tbq4_0 * src, float dst[32]);

static tbq_simd_t tbq_pick(void) {
#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
    {
        tbq_cpu_features_t f;
        tbq_detect_cpu(&f);
        if (f.has_rvv) return TBQ_SIMD_RVV;
    }
#endif
    /* NEON / AVX2 lanes will be added when those TUs land. */
    return TBQ_SIMD_REF;
}

static tbq_simd_t g_forced = (tbq_simd_t)-1;

static tbq_simd_t tbq_simd(void) {
    static tbq_simd_t cached = (tbq_simd_t)-1;
    if (g_forced != (tbq_simd_t)-1) return g_forced;
    if (cached == (tbq_simd_t)-1) {
        /* Allow opt-out via env for triaging the SIMD path. */
        const char * env = getenv("TBQ_FORCE_SIMD");
        if (env && *env) {
            if (!strcmp(env, "ref"))      cached = TBQ_SIMD_REF;
            else if (!strcmp(env, "neon")) cached = TBQ_SIMD_NEON;
            else if (!strcmp(env, "avx2")) cached = TBQ_SIMD_AVX2;
            else if (!strcmp(env, "rvv"))  cached = TBQ_SIMD_RVV;
            else cached = tbq_pick();
        } else {
            cached = tbq_pick();
        }
    }
    return cached;
}

void tbq_force_simd(int lane) {
    g_forced = (tbq_simd_t)lane;
}

const char * tbq_active_simd(void) {
    switch (tbq_simd()) {
        case TBQ_SIMD_RVV:  return "rvv";
        case TBQ_SIMD_NEON: return "neon";
        case TBQ_SIMD_AVX2: return "avx2";
        default:            return "ref";
    }
}

void tbq_quantize_tbq3_block(const float src[32], tbq_block_tbq3_0 * dst) {
    switch (tbq_simd()) {
#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
        case TBQ_SIMD_RVV: tbq_quantize_tbq3_block_rvv(src, dst); return;
#endif
        default: tbq_quantize_tbq3_block_ref(src, dst); return;
    }
}

void tbq_quantize_tbq4_block(const float src[32], tbq_block_tbq4_0 * dst) {
    switch (tbq_simd()) {
#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
        case TBQ_SIMD_RVV: tbq_quantize_tbq4_block_rvv(src, dst); return;
#endif
        default: tbq_quantize_tbq4_block_ref(src, dst); return;
    }
}

void tbq_decode_tbq3_block(const tbq_block_tbq3_0 * src, float dst[32]) {
    switch (tbq_simd()) {
#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
        case TBQ_SIMD_RVV: tbq_decode_tbq3_block_rvv(src, dst); return;
#endif
        default: tbq_decode_tbq3_block_ref(src, dst); return;
    }
}

void tbq_decode_tbq4_block(const tbq_block_tbq4_0 * src, float dst[32]) {
    switch (tbq_simd()) {
#if defined(TBQ_HAVE_RVV) && TBQ_HAVE_RVV
        case TBQ_SIMD_RVV: tbq_decode_tbq4_block_rvv(src, dst); return;
#endif
        default: tbq_decode_tbq4_block_ref(src, dst); return;
    }
}
