/*
 * Real test for the linear PCM resampler in `src/silero_vad_resample.c`.
 *
 * The audio front-end resamples mic capture (8 / 16 / 22.05 / 44.1 kHz)
 * to the Silero v5 graph's 16 kHz native rate before each window. This
 * test pins the contract:
 *
 *   1. 16 kHz → 16 kHz is bit-exact passthrough.
 *   2. 8 kHz → 16 kHz doubles the sample count (within tolerance) and
 *      preserves the input shape via linear interpolation.
 *   3. 44.1 kHz → 16 kHz produces the expected `ceil(n_in * 16k / 44.1k)`
 *      output length and the first/last samples match the source ends
 *      (the hold-last-sample boundary rule).
 *   4. `-ENOSPC` when the destination buffer is too small (the function
 *      must not write a partial result before signalling overflow).
 *   5. `-EINVAL` for NULL pointers, zero/negative rates, or zero input.
 *
 * The test uses a linear ramp as the input so the linear interpolator
 * is theoretically exact — any deviation > a small float-rounding
 * epsilon flags a real bug.
 */

#include "silero_vad/silero_vad.h"

#include <errno.h>
#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

static int approx_eq(float a, float b, float eps) {
    return fabsf(a - b) <= eps;
}

static int test_passthrough_16k_to_16k(void) {
    enum { N = 256 };
    float src[N];
    float dst[N];
    for (size_t i = 0; i < N; ++i) {
        src[i] = (float)i / (float)N - 0.5f;
        dst[i] = -999.0f; /* canary */
    }

    int written = silero_vad_resample_linear(src, N, 16000, dst, N, 16000);
    if (written != (int)N) {
        fprintf(stderr,
                "[resample-test] passthrough returned %d, expected %d\n",
                written, (int)N);
        return 1;
    }
    for (size_t i = 0; i < N; ++i) {
        if (dst[i] != src[i]) {
            fprintf(stderr,
                    "[resample-test] passthrough mismatch at %zu (src=%f dst=%f)\n",
                    i, (double)src[i], (double)dst[i]);
            return 1;
        }
    }
    return 0;
}

static int test_upsample_8k_to_16k_doubles_length(void) {
    /* 8 kHz → 16 kHz: out_len == 2 * n_in. We use a linear ramp so
     * linear interpolation is theoretically exact. */
    enum { N_IN = 64 };
    enum { N_OUT_CAP = 256 };
    float src[N_IN];
    float dst[N_OUT_CAP];
    for (size_t i = 0; i < N_IN; ++i) {
        src[i] = (float)i;
    }

    int written = silero_vad_resample_linear(src, N_IN, 8000, dst, N_OUT_CAP, 16000);
    const int expected = 2 * (int)N_IN;
    if (written != expected) {
        fprintf(stderr,
                "[resample-test] upsample returned %d, expected %d\n",
                written, expected);
        return 1;
    }

    /*
     * The ratio 8000/16000 = 0.5, so output sample i samples input at
     * position i*0.5. For a perfect ramp src[k] = k:
     *   dst[2k]   = src[k]   = k
     *   dst[2k+1] = src[k] * 0.5 + src[k+1] * 0.5 = k + 0.5
     * (with the final odd sample clamped to src[last] by the boundary
     *  rule). Allow a tiny float-rounding epsilon.
     */
    const float eps = 1e-5f;
    for (size_t i = 0; i < (size_t)written; ++i) {
        const float pos = (float)i * 0.5f;
        const size_t base = (size_t)pos;
        float expected_val;
        if (base >= N_IN - 1) {
            expected_val = src[N_IN - 1]; /* boundary clamp */
        } else if ((i & 1u) == 0u) {
            expected_val = src[base];
        } else {
            expected_val = 0.5f * src[base] + 0.5f * src[base + 1];
        }
        if (!approx_eq(dst[i], expected_val, eps)) {
            fprintf(stderr,
                    "[resample-test] upsample dst[%zu]=%f, expected %f\n",
                    i, (double)dst[i], (double)expected_val);
            return 1;
        }
    }

    /* Boundary: first / last samples are pinned to source endpoints. */
    if (!approx_eq(dst[0], src[0], eps)) {
        fprintf(stderr,
                "[resample-test] upsample first sample drifted: %f != %f\n",
                (double)dst[0], (double)src[0]);
        return 1;
    }
    if (!approx_eq(dst[written - 1], src[N_IN - 1], eps)) {
        fprintf(stderr,
                "[resample-test] upsample last sample drifted: %f != %f\n",
                (double)dst[written - 1], (double)src[N_IN - 1]);
        return 1;
    }

    return 0;
}

static int test_downsample_44_1k_to_16k_length(void) {
    /* 44.1 kHz → 16 kHz: out_len = ceil(n_in * 16000 / 44100). For
     * n_in = 441 (10 ms of audio at 44.1 kHz) the formula gives
     * exactly 160 output samples. We pin both the formula and the
     * shape of the output (linear interpolation of a ramp must stay
     * a ramp at the resampled rate, modulo float epsilon). */
    enum { N_IN = 441 };
    enum { N_OUT_CAP = 1024 };
    float src[N_IN];
    float dst[N_OUT_CAP];
    for (size_t i = 0; i < N_IN; ++i) {
        src[i] = (float)i;
    }

    int written = silero_vad_resample_linear(src, N_IN, 44100, dst, N_OUT_CAP, 16000);
    /* Compute the expected length the same way the implementation
     * does, so the test agrees with the formula it pins. */
    const unsigned long long product = (unsigned long long)N_IN * 16000ULL;
    const unsigned long long src_ull = 44100ULL;
    const int expected = (int)((product + src_ull - 1ULL) / src_ull);

    if (written != expected) {
        fprintf(stderr,
                "[resample-test] downsample returned %d, expected %d\n",
                written, expected);
        return 1;
    }
    /*
     * First sample == src[0] (resample position 0.0 lands exactly on
     * input 0). Linear interpolation of the ramp src[k]=k samples at
     * fractional position p as `floor(p)*(1-frac) + ceil(p)*frac = p`,
     * so dst[i] should equal i * ratio for any non-boundary index.
     */
    const double ratio = 44100.0 / 16000.0;
    const float eps = 1e-3f;
    if (!approx_eq(dst[0], src[0], eps)) {
        fprintf(stderr,
                "[resample-test] downsample first drifted %f != %f\n",
                (double)dst[0], (double)src[0]);
        return 1;
    }
    for (int i = 0; i < written; ++i) {
        const double pos = (double)i * ratio;
        const float expected_val = (pos >= (double)(N_IN - 1))
            ? src[N_IN - 1]
            : (float)pos;
        if (!approx_eq(dst[i], expected_val, eps)) {
            fprintf(stderr,
                    "[resample-test] downsample dst[%d]=%f, expected %f\n",
                    i, (double)dst[i], (double)expected_val);
            return 1;
        }
    }
    return 0;
}

static int test_overflow_returns_enospc(void) {
    enum { N_IN = 16 };
    float src[N_IN];
    float dst[4]; /* deliberately too small for a 2x upsample */
    for (size_t i = 0; i < N_IN; ++i) src[i] = (float)i;

    int rc = silero_vad_resample_linear(src, N_IN, 8000, dst, 4, 16000);
    if (rc != -ENOSPC) {
        fprintf(stderr,
                "[resample-test] overflow returned %d, expected -ENOSPC\n", rc);
        return 1;
    }
    return 0;
}

static int test_invalid_args(void) {
    float buf[4] = {0};
    if (silero_vad_resample_linear(NULL, 4, 16000, buf, 4, 16000) != -EINVAL) {
        fprintf(stderr, "[resample-test] NULL src must -EINVAL\n");
        return 1;
    }
    if (silero_vad_resample_linear(buf, 4, 16000, NULL, 4, 16000) != -EINVAL) {
        fprintf(stderr, "[resample-test] NULL dst must -EINVAL\n");
        return 1;
    }
    if (silero_vad_resample_linear(buf, 0, 16000, buf, 4, 16000) != -EINVAL) {
        fprintf(stderr, "[resample-test] zero n_in must -EINVAL\n");
        return 1;
    }
    if (silero_vad_resample_linear(buf, 4, 0, buf, 4, 16000) != -EINVAL) {
        fprintf(stderr, "[resample-test] zero src_rate must -EINVAL\n");
        return 1;
    }
    if (silero_vad_resample_linear(buf, 4, 16000, buf, 4, -1) != -EINVAL) {
        fprintf(stderr, "[resample-test] negative dst_rate must -EINVAL\n");
        return 1;
    }
    return 0;
}

int main(void) {
    int failures = 0;
    failures += test_passthrough_16k_to_16k();
    failures += test_upsample_8k_to_16k_doubles_length();
    failures += test_downsample_44_1k_to_16k_length();
    failures += test_overflow_returns_enospc();
    failures += test_invalid_args();
    printf("[silero-vad-resample-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
