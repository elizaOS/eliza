/*
 * wakeword_melspec.c — pure-C log-mel spectrogram for the wake-word
 * front-end.
 *
 * Pipeline per column:
 *   1. Hann window over `WW_N_FFT` (= 400) samples.
 *   2. Real-input DFT, magnitude squared (power spectrum) of bins
 *      [0, WW_N_FFT/2].
 *   3. Triangular mel filter bank (`WW_N_MELS` = 80, fmin = 0 Hz,
 *      fmax = 8000 Hz, HTK mel) → mel power.
 *   4. log(mel_power + 1e-10).
 *
 * This is the first-pass reference implementation. It is correct, slow,
 * and intentionally free of SIMD: `wakeword_melspec_test.c` exercises
 * spectral correctness (a 1 kHz tone lights up the bin whose centre
 * frequency is closest to 1 kHz). Phase 2 will replace the naive DFT
 * with FFTW or pocketfft, drop the per-column allocations, and
 * eventually move the whole melspec onto the elizaOS/llama.cpp ggml
 * dispatcher so the Hann window and mel filter bank are static tensors
 * the dispatcher fuses.
 *
 * The mel filter bank is initialized lazily on first call and cached
 * for the process lifetime. The cache is read-only after init, so it
 * is thread-safe under the standard "publish-via-init-once" pattern;
 * here we use a simple `initialized` flag because the caller (the
 * streaming session) is single-threaded for a given `wakeword_handle`.
 *
 * No defensive try/catch on the success path. Bad arguments return
 * `-EINVAL`; there is no other failure mode.
 */

#include "wakeword_internal.h"

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define WW_N_BINS (WW_N_FFT / 2 + 1)  /* 201 */
#define WW_LOG_FLOOR 1e-10f

/* ---------------- Hann window + mel filter bank cache ---------------- */

static float g_hann[WW_N_FFT];
static float g_mel_filters[WW_N_MELS][WW_N_BINS];
static float g_mel_centers_hz[WW_N_MELS];
static bool g_initialized = false;

static float hz_to_mel(float hz) {
    /* HTK mel scale (matches librosa default `htk=True` and the openWakeWord
     * reference). */
    return 2595.0f * log10f(1.0f + hz / 700.0f);
}

static float mel_to_hz(float mel) {
    return 700.0f * (powf(10.0f, mel / 2595.0f) - 1.0f);
}

static void init_tables(void) {
    if (g_initialized) return;

    /* Hann window: w[n] = 0.5 * (1 - cos(2π n / (N-1))). */
    for (int n = 0; n < WW_N_FFT; ++n) {
        g_hann[n] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)n /
                                        (float)(WW_N_FFT - 1)));
    }

    /* Triangular mel filter bank, slaney-style: WW_N_MELS + 2 mel-equispaced
     * points map to FFT bins; each filter spans (left, center, right). */
    const float mel_min = hz_to_mel(WW_FMIN_HZ);
    const float mel_max = hz_to_mel(WW_FMAX_HZ);
    float mel_points[WW_N_MELS + 2];
    int bin_points[WW_N_MELS + 2];
    for (int i = 0; i < WW_N_MELS + 2; ++i) {
        mel_points[i] = mel_min + (mel_max - mel_min) * (float)i /
                                  (float)(WW_N_MELS + 1);
        const float hz = mel_to_hz(mel_points[i]);
        /* FFT bin index of frequency hz at sample rate WAKEWORD_SAMPLE_RATE,
         * window length WW_N_FFT. */
        const float bin_f = (float)WW_N_FFT * hz / (float)WAKEWORD_SAMPLE_RATE;
        int bin = (int)floorf(bin_f);
        if (bin < 0) bin = 0;
        if (bin > WW_N_BINS - 1) bin = WW_N_BINS - 1;
        bin_points[i] = bin;
    }

    memset(g_mel_filters, 0, sizeof(g_mel_filters));
    for (int m = 0; m < WW_N_MELS; ++m) {
        const int left = bin_points[m];
        const int center = bin_points[m + 1];
        const int right = bin_points[m + 2];
        g_mel_centers_hz[m] = mel_to_hz(mel_points[m + 1]);

        /* Rising edge. */
        for (int k = left; k < center; ++k) {
            const int span = center - left;
            if (span > 0) {
                g_mel_filters[m][k] = (float)(k - left) / (float)span;
            }
        }
        /* Falling edge. */
        for (int k = center; k < right; ++k) {
            const int span = right - center;
            if (span > 0) {
                g_mel_filters[m][k] = (float)(right - k) / (float)span;
            }
        }
        /* Center bin gets weight 1.0 only when left < center < right
         * (otherwise it's already covered by one of the loops above when
         * the spans are non-degenerate). For safety and to match the
         * common slaney convention, force the center to 1.0 when the
         * rising-edge loop did not cover it. */
        if (center > left && center < right && g_mel_filters[m][center] == 0.0f) {
            g_mel_filters[m][center] = 1.0f;
        }
    }

    g_initialized = true;
}

/* ---------------- naive real-input DFT ---------------- */

/*
 * Compute |X[k]|^2 for k in [0, WW_N_BINS) from a windowed real input.
 * O(N^2) — fine for the first-pass reference; Phase 2 swaps in FFTW.
 */
static void rfft_power(const float *windowed, float *power_out) {
    for (int k = 0; k < WW_N_BINS; ++k) {
        float re = 0.0f;
        float im = 0.0f;
        const float w = -2.0f * (float)M_PI * (float)k / (float)WW_N_FFT;
        for (int n = 0; n < WW_N_FFT; ++n) {
            const float x = windowed[n];
            const float angle = w * (float)n;
            re += x * cosf(angle);
            im += x * sinf(angle);
        }
        power_out[k] = re * re + im * im;
    }
}

/* ---------------- public surface ---------------- */

int wakeword_melspec_column(const float *pcm_window, float *mel_out) {
    if (!pcm_window || !mel_out) return -EINVAL;
    init_tables();

    float windowed[WW_N_FFT];
    for (int n = 0; n < WW_N_FFT; ++n) {
        windowed[n] = pcm_window[n] * g_hann[n];
    }

    float power[WW_N_BINS];
    rfft_power(windowed, power);

    for (int m = 0; m < WW_N_MELS; ++m) {
        float energy = 0.0f;
        const float *filt = g_mel_filters[m];
        for (int k = 0; k < WW_N_BINS; ++k) {
            energy += power[k] * filt[k];
        }
        mel_out[m] = logf(energy + WW_LOG_FLOOR);
    }
    return 0;
}

void wakeword_melspec_state_init(wakeword_melspec_state *state) {
    if (!state) return;
    memset(state, 0, sizeof(*state));
}

size_t wakeword_melspec_max_columns(size_t n_input_samples) {
    /* With up to (WW_N_FFT - 1) carried samples, a fresh chunk of
     * `n_input_samples` exposes at most
     * `(carry + n_input_samples - WW_N_FFT) / WW_HOP_LEN + 1` columns.
     * We bound generously: assume max carry. */
    const size_t total = n_input_samples + (WW_N_FFT - 1);
    if (total < (size_t)WW_N_FFT) return 0;
    return (total - (size_t)WW_N_FFT) / (size_t)WW_HOP_LEN + 1;
}

int wakeword_melspec_stream(wakeword_melspec_state *state,
                            const float *pcm,
                            size_t n_samples,
                            float *out_columns,
                            size_t *out_n_columns) {
    if (!state || !out_n_columns) return -EINVAL;
    if (n_samples > 0 && !pcm) return -EINVAL;
    if (!out_columns) return -EINVAL;
    *out_n_columns = 0;

    init_tables();

    /* Walk the virtual stream = state->carry || pcm. We index into either
     * with a single cursor and read on demand. */
    const size_t total = state->n_carry + n_samples;
    size_t cursor = 0;

    while (cursor + (size_t)WW_N_FFT <= total) {
        float window[WW_N_FFT];
        for (int i = 0; i < WW_N_FFT; ++i) {
            const size_t idx = cursor + (size_t)i;
            float sample;
            if (idx < state->n_carry) {
                sample = state->carry[idx];
            } else {
                sample = pcm[idx - state->n_carry];
            }
            window[i] = sample * g_hann[i];
        }

        float power[WW_N_BINS];
        rfft_power(window, power);
        float *col = out_columns + (*out_n_columns) * (size_t)WW_N_MELS;
        for (int m = 0; m < WW_N_MELS; ++m) {
            float energy = 0.0f;
            const float *filt = g_mel_filters[m];
            for (int k = 0; k < WW_N_BINS; ++k) {
                energy += power[k] * filt[k];
            }
            col[m] = logf(energy + WW_LOG_FLOOR);
        }
        (*out_n_columns)++;
        cursor += (size_t)WW_HOP_LEN;
    }

    /* Stash the unconsumed tail. The new tail length is the number of
     * samples between `cursor` and `total`; clamp to WW_N_FFT - 1
     * because no more than that can be useful. */
    size_t new_carry_len = total - cursor;
    if (new_carry_len > (size_t)(WW_N_FFT - 1)) {
        /* This only happens if the caller pushed an enormous chunk
         * without ever asking for output — impossible under the loop
         * above (it consumes WW_HOP_LEN per iteration), but bound
         * defensively. */
        const size_t drop = new_carry_len - (size_t)(WW_N_FFT - 1);
        cursor += drop;
        new_carry_len -= drop;
    }
    float new_carry[WW_N_FFT];
    for (size_t i = 0; i < new_carry_len; ++i) {
        const size_t idx = cursor + i;
        if (idx < state->n_carry) {
            new_carry[i] = state->carry[idx];
        } else {
            new_carry[i] = pcm[idx - state->n_carry];
        }
    }
    memcpy(state->carry, new_carry, new_carry_len * sizeof(float));
    state->n_carry = new_carry_len;
    return 0;
}

float wakeword_mel_bin_center_hz(int mel_idx) {
    if (mel_idx < 0 || mel_idx >= WW_N_MELS) return 0.0f;
    init_tables();
    return g_mel_centers_hz[mel_idx];
}
