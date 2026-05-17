/*
 * Deterministic JL projection-matrix construction.
 *
 * IMPORTANT: this is *not* bit-compatible with torch.randn(). PyTorch
 * uses a Philox-based generator and a specific Box-Muller pipeline that
 * we don't reproduce here. Hosts that need bit-parity with the Python
 * reference should ship the projection matrix in the fixture/sidecar
 * (see scripts/gen_fixtures.py and qjl_apply.py's `rand_prj` field).
 *
 * For standalone hosts that just need a "good enough" Π without a
 * companion sidecar, this builds one from a 64-bit splitmix-seeded
 * Mersenne-Twister-style stream + Box-Muller, which is repeatable and
 * statistically sane (independent N(0,1) draws).
 */

#include "qjl/qjl.h"
#include <math.h>

/* splitmix64: cheap, well-distributed seed expander. */
static uint64_t splitmix64(uint64_t *state) {
    uint64_t z = (*state += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

/* uniform in (0, 1] from a 64-bit splitmix64 draw. */
static double u01_open(uint64_t *state) {
    uint64_t v = splitmix64(state);
    /* Use the high 53 bits, shift to (0, 1]. Avoid exact 0 for log(). */
    double u = (double)((v >> 11) | 1ULL) * (1.0 / 9007199254740992.0);
    return u;
}

int qjl_make_projection_mt(float *prj, int head_dim, int proj_dim, uint64_t seed) {
    if (!prj || head_dim <= 0 || proj_dim <= 0) return -1;
    uint64_t state = seed ^ 0xC0FFEE1234567890ULL;
    int total = head_dim * proj_dim;
    int i = 0;
    while (i + 1 < total) {
        double u1 = u01_open(&state);
        double u2 = u01_open(&state);
        double r  = sqrt(-2.0 * log(u1));
        double th = 6.28318530717958647692 * u2;
        prj[i++] = (float)(r * cos(th));
        prj[i++] = (float)(r * sin(th));
    }
    if (i < total) {
        double u1 = u01_open(&state);
        double u2 = u01_open(&state);
        double r  = sqrt(-2.0 * log(u1));
        double th = 6.28318530717958647692 * u2;
        prj[i++] = (float)(r * cos(th));
    }
    return 0;
}

/* fp32 <-> bf16 helpers. */
uint16_t qjl_fp32_to_bf16(float x) {
    union { float f; uint32_t u; } v = { .f = x };
    uint32_t u = v.u;
    /* Round-to-nearest-even with NaN passthrough. */
    if ((u & 0x7F800000u) == 0x7F800000u && (u & 0x007FFFFFu)) {
        /* NaN: ensure quiet bit, low 16 nonzero. */
        return (uint16_t)((u >> 16) | 0x40);
    }
    uint32_t lsb     = (u >> 16) & 1u;
    uint32_t rounding = 0x7FFFu + lsb;
    u += rounding;
    return (uint16_t)(u >> 16);
}

float qjl_bf16_to_fp32(uint16_t b) {
    union { float f; uint32_t u; } v;
    v.u = ((uint32_t)b) << 16;
    return v.f;
}
