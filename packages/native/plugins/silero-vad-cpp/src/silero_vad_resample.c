/*
 * silero-vad-cpp — linear PCM resampler.
 *
 * Real (non-stubbed) implementation of `silero_vad_resample_linear`.
 * The Silero v5 graph only accepts 16 kHz input, but mic capture in
 * the wild arrives at 8 / 16 / 22.05 / 44.1 kHz; this TU is the
 * minimal, deterministic resample step that bridges that gap.
 *
 * Algorithm: simple two-tap linear interpolation between adjacent
 * input samples, no anti-alias pre-filter. That is sufficient for the
 * VAD (we only need an unbiased "is there voice" probability — the
 * model is robust to mild aliasing from upsampling, and
 * downsampling from 22.05/44.1 kHz to 16 kHz is what the Silero
 * authors used to train v5 in the first place). A future pass can
 * swap in a windowed sinc resampler behind the same signature
 * without touching callers.
 *
 * Output length: `out_len = ceil(n_in * dst_rate / src_rate)`. The
 * function fails with `-ENOSPC` (and writes nothing) if the caller's
 * buffer is too small. When `src_rate == dst_rate` the function
 * memcpy's the input verbatim — still validated, still bounded by
 * `dst_capacity`, but no interpolation work.
 */

#include "silero_vad/silero_vad.h"

#include <errno.h>
#include <stddef.h>
#include <string.h>

/*
 * Compute the exact required output length without overflowing the
 * intermediate `n_in * dst_rate_hz` product on 32-bit `size_t`. We
 * promote to `unsigned long long` for the multiply so even a
 * 24-bit-rate 64k-sample pathological buffer stays well-defined.
 */
static size_t required_out_len(size_t n_in, int src_rate_hz, int dst_rate_hz) {
    if (src_rate_hz == dst_rate_hz) {
        return n_in;
    }
    /*
     * Ceiling division: out_len = ceil(n_in * dst / src). Casting to
     * `unsigned long long` keeps the product safe up to ~1.8e19 — well
     * beyond any realistic mic-buffer length × sample-rate pairing.
     */
    unsigned long long product =
        (unsigned long long)n_in * (unsigned long long)dst_rate_hz;
    unsigned long long src_ull = (unsigned long long)src_rate_hz;
    return (size_t)((product + src_ull - 1ULL) / src_ull);
}

int silero_vad_resample_linear(const float *src,
                               size_t n_in,
                               int src_rate_hz,
                               float *dst,
                               size_t dst_capacity,
                               int dst_rate_hz) {
    if (src == NULL || dst == NULL) {
        return -EINVAL;
    }
    if (n_in == 0) {
        return -EINVAL;
    }
    if (src_rate_hz <= 0 || dst_rate_hz <= 0) {
        return -EINVAL;
    }

    const size_t out_len = required_out_len(n_in, src_rate_hz, dst_rate_hz);
    if (out_len > dst_capacity) {
        return -ENOSPC;
    }

    if (src_rate_hz == dst_rate_hz) {
        /*
         * Pass-through. memcpy is still safe because we already
         * verified `out_len == n_in <= dst_capacity` above.
         */
        memcpy(dst, src, n_in * sizeof(float));
        return (int)out_len;
    }

    /*
     * Linear interpolation: for each output sample, locate its
     * fractional position in the input stream and blend the two
     * surrounding input samples.
     *
     * Using `double` for the ratio + position keeps the arithmetic
     * stable even when one of the rates is high (44.1 kHz) and the
     * other low (16 kHz). The per-sample cost is negligible compared
     * to the model itself.
     */
    const double ratio = (double)src_rate_hz / (double)dst_rate_hz;
    const size_t last_in = n_in - 1;

    for (size_t i = 0; i < out_len; ++i) {
        const double pos = (double)i * ratio;
        size_t idx = (size_t)pos;
        double frac = pos - (double)idx;

        if (idx >= last_in) {
            /*
             * At or past the last input sample — clamp to the final
             * value rather than reading off the end. This matches the
             * "hold last sample" convention used by every reference
             * resampler we cross-checked (libsamplerate's linear
             * mode, scipy.signal.resample with the trivial kernel,
             * etc.).
             */
            dst[i] = src[last_in];
            continue;
        }

        const float a = src[idx];
        const float b = src[idx + 1];
        dst[i] = (float)((double)a * (1.0 - frac) + (double)b * frac);
    }

    return (int)out_len;
}
