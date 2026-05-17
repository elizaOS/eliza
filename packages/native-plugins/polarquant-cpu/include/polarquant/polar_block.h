/* polar_block.h - block_q4_polar layout + small inline helpers.
 *
 * Layout is locked here.  Any change requires re-emitting GGUF files
 * and bumping the converter / decoder in lockstep.
 *
 *   typedef struct {
 *       polar_fp16_t d;                  // 2  bytes (per-block L2 norm)
 *       uint8_t      qs[QK_POLAR/2];     // 64 bytes (4-bit codes, 2/byte)
 *       uint8_t      qjl[QJL_RESIDUAL_BYTES];  // 16 bytes (1-bit residual)
 *   } block_q4_polar;
 *
 * Total: 82 bytes per 128-element block.
 *   With residual:    82*8 / 128 = 5.125 bpw
 *   Without residual: 66*8 / 128 = 4.125 bpw  (qjl[] left at zero)
 *
 * The block is __attribute__((packed)) to guarantee the GGUF on-disk
 * size matches sizeof(block_q4_polar) on every supported compiler /
 * ABI (no padding between qs and qjl).
 */

#ifndef POLARQUANT_POLAR_BLOCK_H
#define POLARQUANT_POLAR_BLOCK_H

#include <stdint.h>
#include <string.h>

/* QK_POLAR / QJL_RESIDUAL_BYTES / polar_fp16_t are defined by the
 * top-level polarquant.h before it includes this file.
 */

typedef struct __attribute__((packed)) {
    polar_fp16_t d;                          /* per-block L2 norm */
    uint8_t      qs[QK_POLAR / 2];           /* 4-bit codes, 2 per byte */
    uint8_t      qjl[QJL_RESIDUAL_BYTES];    /* optional 1-bit QJL residual */
} block_q4_polar;

/* The matching activation block from llama.cpp.  Defined locally so
 * this reference can compile standalone; when integrated into the
 * fork it will be the existing ggml-common.h definition.
 */
#ifndef POLAR_BLOCK_Q8_0_DEFINED
#define POLAR_BLOCK_Q8_0_DEFINED
#define QK8_0 32
struct block_q8_0 {
    polar_fp16_t d;            /* per-block fp16 scale */
    int8_t       qs[QK8_0];    /* int8 codes */
} __attribute__((packed));
#endif

/* IEEE-754 binary16 -> binary32 (no FMA / no SIMD).  Standalone
 * implementation matching __extendhfsf2 semantics so this works on
 * MSVC / older compilers too.
 */
static inline float polar_fp16_to_fp32(polar_fp16_t h) {
    const uint32_t s = ((uint32_t)h & 0x8000u) << 16;
    const uint32_t e = ((uint32_t)h & 0x7C00u) >> 10;
    const uint32_t m =  (uint32_t)h & 0x03FFu;
    uint32_t out;

    if (e == 0) {
        if (m == 0) {
            out = s;                                /* +/- zero */
        } else {
            /* subnormal half -> normalized float */
            uint32_t mantissa = m;
            int      exp      = -1;
            while ((mantissa & 0x400u) == 0u) {
                mantissa <<= 1;
                exp -= 1;
            }
            mantissa &= 0x3FFu;
            out = s | ((uint32_t)(112 + exp + 1) << 23) | (mantissa << 13);
        }
    } else if (e == 0x1F) {
        /* inf / nan */
        out = s | 0x7F800000u | (m << 13);
    } else {
        out = s | ((e + 112u) << 23) | (m << 13);
    }

    float f;
    memcpy(&f, &out, sizeof(f));
    return f;
}

/* binary32 -> binary16 with round-to-nearest-even.  Matches the
 * conversion ggml uses for storing per-block scales.
 */
static inline polar_fp16_t polar_fp32_to_fp16(float f) {
    uint32_t x;
    memcpy(&x, &f, sizeof(x));

    const uint32_t s    = (x >> 16) & 0x8000u;
    int32_t        e    = (int32_t)((x >> 23) & 0xFFu) - 127 + 15;
    uint32_t       m    = x & 0x7FFFFFu;

    if (e >= 0x1F) {
        /* overflow -> inf, or pass-through nan */
        if (((x >> 23) & 0xFFu) == 0xFFu && m != 0u) {
            return (polar_fp16_t)(s | 0x7C00u | (m >> 13) | 1u);
        }
        return (polar_fp16_t)(s | 0x7C00u);
    }
    if (e <= 0) {
        if (e < -10) {
            return (polar_fp16_t)s;                  /* underflow -> +/-0 */
        }
        m |= 0x800000u;
        const uint32_t shift = (uint32_t)(14 - e);
        const uint32_t round = 1u << (shift - 1u);
        const uint32_t bits  = m + round;
        if (bits & (1u << shift)) {
            /* rounding bumped us into the smallest normal */
        }
        const uint32_t mant = bits >> shift;
        return (polar_fp16_t)(s | mant);
    }

    /* normal case + RNE */
    const uint32_t round = 0x1000u + ((m >> 13) & 1u);
    const uint32_t bits  = m + round;
    if (bits & 0x800000u) {
        e += 1;
        m = 0;
    } else {
        m = bits >> 13;
    }
    if (e >= 0x1F) {
        return (polar_fp16_t)(s | 0x7C00u);
    }
    return (polar_fp16_t)(s | ((uint32_t)e << 10) | m);
}

#endif /* POLARQUANT_POLAR_BLOCK_H */
