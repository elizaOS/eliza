/*
 * wakeword_melspec.c — log-mel spectrogram for the wake-word
 * front-end. Two modes:
 *
 *   1. GGUF-bound (the runtime path).
 *      The session loads `wakeword.melspec.stft_real` (257, 1, 512),
 *      `wakeword.melspec.stft_imag` (257, 1, 512), and
 *      `wakeword.melspec.melW` (257, 32) from `melspec.gguf`. The
 *      streaming melspec replicates the openWakeWord ONNX exactly:
 *
 *        1. Slide a 512-sample window with hop 160 over the input.
 *        2. For each window: real_k  = dot(window, stft_real[k])
 *                            imag_k  = dot(window, stft_imag[k])
 *           power = real_k^2 + imag_k^2     for k in [0, 257).
 *        3. mel_pow  = power @ melW               (1, 32) per column
 *           mel_db   = 10 * log10(clip(mel_pow, 1e-10, inf))
 *           peak     = ReduceMax(mel_db) over the whole call
 *           out      = clip(mel_db, peak - 80, inf)
 *
 *   2. Legacy bank (unit-test fallback).
 *      Used when the caller initializes the state with NULL tensors.
 *      Generates a Hann window + 80-mel triangular filter bank
 *      in-process so the spectral-correctness unit test
 *      (`test/wakeword_melspec_test.c`) can run without a GGUF on
 *      hand. This is the same generic 0–8000 Hz bank the Phase 1
 *      reference shipped — kept here so `wakeword_mel_bin_center_hz`
 *      stays exercised against a known oracle.
 *
 * Pure C, no SIMD, no FFT library. The runtime touch points (number
 * of mel columns per 80 ms hop = 8) are small enough that the naive
 * O(N_BINS · N_FFT) loop dominates trivially; a real-time CPU budget
 * of ~1% per second of audio is comfortably hit on a laptop core.
 */

#include "wakeword_internal.h"

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define LEGACY_FMIN_HZ 0.0f
#define LEGACY_FMAX_HZ 8000.0f
/* Legacy window length matches the upstream STFT length so the unit
 * test exercises the same window math the runtime uses. */
#define LEGACY_N_BINS  WW_N_BINS

/* ---------------- Legacy (unit-test) Hann + mel filter bank ---------- */

static float g_legacy_hann[WW_N_FFT];
static float g_legacy_mel_filters[WW_LEGACY_N_MELS][LEGACY_N_BINS];
static float g_legacy_mel_centers_hz[WW_LEGACY_N_MELS];
static bool g_legacy_initialized = false;

static float hz_to_mel(float hz) {
    return 2595.0f * log10f(1.0f + hz / 700.0f);
}

static float mel_to_hz(float mel) {
    return 700.0f * (powf(10.0f, mel / 2595.0f) - 1.0f);
}

static void init_legacy_tables(void) {
    if (g_legacy_initialized) return;
    for (int n = 0; n < WW_N_FFT; ++n) {
        g_legacy_hann[n] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)n /
                                               (float)(WW_N_FFT - 1)));
    }
    const float mel_min = hz_to_mel(LEGACY_FMIN_HZ);
    const float mel_max = hz_to_mel(LEGACY_FMAX_HZ);
    float mel_points[WW_LEGACY_N_MELS + 2];
    int   bin_points[WW_LEGACY_N_MELS + 2];
    for (int i = 0; i < WW_LEGACY_N_MELS + 2; ++i) {
        mel_points[i] = mel_min + (mel_max - mel_min) * (float)i /
                                  (float)(WW_LEGACY_N_MELS + 1);
        const float hz = mel_to_hz(mel_points[i]);
        const float bin_f = (float)WW_N_FFT * hz / (float)WAKEWORD_SAMPLE_RATE;
        int bin = (int)floorf(bin_f);
        if (bin < 0) bin = 0;
        if (bin > LEGACY_N_BINS - 1) bin = LEGACY_N_BINS - 1;
        bin_points[i] = bin;
    }
    memset(g_legacy_mel_filters, 0, sizeof(g_legacy_mel_filters));
    for (int m = 0; m < WW_LEGACY_N_MELS; ++m) {
        const int left = bin_points[m];
        const int center = bin_points[m + 1];
        const int right = bin_points[m + 2];
        g_legacy_mel_centers_hz[m] = mel_to_hz(mel_points[m + 1]);
        for (int k = left; k < center; ++k) {
            const int span = center - left;
            if (span > 0) g_legacy_mel_filters[m][k] = (float)(k - left) / (float)span;
        }
        for (int k = center; k < right; ++k) {
            const int span = right - center;
            if (span > 0) g_legacy_mel_filters[m][k] = (float)(right - k) / (float)span;
        }
        if (center > left && center < right && g_legacy_mel_filters[m][center] == 0.0f) {
            g_legacy_mel_filters[m][center] = 1.0f;
        }
    }
    g_legacy_initialized = true;
}

float wakeword_mel_bin_center_hz(int mel_idx) {
    if (mel_idx < 0 || mel_idx >= WW_LEGACY_N_MELS) return 0.0f;
    init_legacy_tables();
    return g_legacy_mel_centers_hz[mel_idx];
}

/* ---------------- Public surface ---------------- */

void wakeword_melspec_state_init(wakeword_melspec_state *state,
                                 const float *stft_real_tensor,
                                 const float *stft_imag_tensor,
                                 const float *mel_filter_tensor) {
    if (!state) return;
    memset(state, 0, sizeof(*state));
    state->stft_real  = stft_real_tensor;
    state->stft_imag  = stft_imag_tensor;
    state->mel_filter = mel_filter_tensor;
}

size_t wakeword_melspec_max_columns(size_t n_input_samples) {
    const size_t total = n_input_samples + (WW_N_FFT - 1);
    if (total < (size_t)WW_N_FFT) return 0;
    return (total - (size_t)WW_N_FFT) / (size_t)WW_HOP_LEN + 1;
}

/* GGUF-mode column: convolution-style STFT (real + imag bases),
 * power = real^2 + imag^2, mel_pow = power @ melW (no log here — log
 * applies after the per-call peak is known). */
static void column_stft_to_mel_pow(const wakeword_melspec_state *state,
                                   const float *window,
                                   float *mel_pow_out /* (32,) */) {
    /* power(k) = (sum_n window[n] * stft_real[k,0,n])^2
     *          + (sum_n window[n] * stft_imag[k,0,n])^2
     *
     * Lay out: stft_real and stft_imag are row-major (257, 1, 512), so
     * the row stride between bin k and k+1 is exactly 512 floats.
     */
    float power[WW_N_BINS];
    for (int k = 0; k < WW_N_BINS; ++k) {
        const float *real_row = state->stft_real + (size_t)k * WW_N_FFT;
        const float *imag_row = state->stft_imag + (size_t)k * WW_N_FFT;
        double re = 0.0, im = 0.0;
        for (int n = 0; n < WW_N_FFT; ++n) {
            const double w = (double)window[n];
            re += w * (double)real_row[n];
            im += w * (double)imag_row[n];
        }
        power[k] = (float)(re * re + im * im);
    }

    /* mel_pow(m) = sum_k power(k) * melW(k, m).
     * melW is (257, 32) row-major; the row stride is 32. */
    for (int m = 0; m < WW_N_MELS; ++m) {
        double acc = 0.0;
        const float *col = state->mel_filter + (size_t)m;
        for (int k = 0; k < WW_N_BINS; ++k) {
            acc += (double)power[k] * (double)col[(size_t)k * WW_N_MELS];
        }
        mel_pow_out[m] = (float)acc;
    }
}

/* Legacy mode: Hann-window, naive DFT, mel-power via the in-process
 * 80-mel bank. Used by the unit test only. The output buffer is sized
 * to WW_N_MELS (32); we collapse the 80-mel bank into 32 by simple
 * binning so callers see a uniform output width. The unit test still
 * exercises the legacy bank's bin centres via `wakeword_mel_bin_center_hz`,
 * which references the 80-mel grid; the column buffer just carries an
 * energy summary for completeness. */
static void column_legacy_log_mel(const float *pcm_window,
                                  float *mel_out /* (32,) */) {
    init_legacy_tables();
    float windowed[WW_N_FFT];
    for (int n = 0; n < WW_N_FFT; ++n) {
        windowed[n] = pcm_window[n] * g_legacy_hann[n];
    }
    /* Naive DFT magnitude squared. */
    float power[LEGACY_N_BINS];
    for (int k = 0; k < LEGACY_N_BINS; ++k) {
        const float w = -2.0f * (float)M_PI * (float)k / (float)WW_N_FFT;
        double re = 0.0, im = 0.0;
        for (int n = 0; n < WW_N_FFT; ++n) {
            const double x = (double)windowed[n];
            const double angle = (double)w * (double)n;
            re += x * cos(angle);
            im += x * sin(angle);
        }
        power[k] = (float)(re * re + im * im);
    }
    /* Apply 80-mel bank, then bin down to 32 by fixed window of 80/32 = 2.5. */
    float mel80[WW_LEGACY_N_MELS];
    for (int m = 0; m < WW_LEGACY_N_MELS; ++m) {
        double e = 0.0;
        const float *filt = g_legacy_mel_filters[m];
        for (int k = 0; k < LEGACY_N_BINS; ++k) e += (double)power[k] * (double)filt[k];
        mel80[m] = logf((float)e + WW_MEL_LOG_CLIP);
    }
    /* Reduce 80→32 by averaging contiguous chunks; preserves the modal
     * bin position the unit test cares about. */
    for (int j = 0; j < WW_N_MELS; ++j) {
        const int lo = (j * WW_LEGACY_N_MELS) / WW_N_MELS;
        const int hi = ((j + 1) * WW_LEGACY_N_MELS) / WW_N_MELS;
        double s = 0.0; int n = 0;
        for (int m = lo; m < hi; ++m) { s += (double)mel80[m]; ++n; }
        mel_out[j] = (n > 0) ? (float)(s / (double)n) : 0.0f;
    }
}

int wakeword_melspec_column(const wakeword_melspec_state *state,
                            const float *pcm_window,
                            float *mel_out) {
    if (!state || !pcm_window || !mel_out) return -EINVAL;

    if (state->stft_real && state->stft_imag && state->mel_filter) {
        float mel_pow[WW_N_MELS];
        column_stft_to_mel_pow(state, pcm_window, mel_pow);
        for (int m = 0; m < WW_N_MELS; ++m) {
            float p = mel_pow[m] < WW_MEL_LOG_CLIP ? WW_MEL_LOG_CLIP : mel_pow[m];
            const float db = 10.0f * log10f(p);
            mel_out[m] = db; /* peak normalization is per-call; single
                              * column applies its own peak in the
                              * loop below. */
        }
        /* Single-column peak floor. */
        float peak = mel_out[0];
        for (int m = 1; m < WW_N_MELS; ++m) {
            if (mel_out[m] > peak) peak = mel_out[m];
        }
        const float floor_db = peak - WW_MEL_DB_FLOOR;
        for (int m = 0; m < WW_N_MELS; ++m) {
            if (mel_out[m] < floor_db) mel_out[m] = floor_db;
        }
        return 0;
    }
    /* Legacy: pure-C bank. */
    column_legacy_log_mel(pcm_window, mel_out);
    return 0;
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

    const bool gguf_mode =
        (state->stft_real && state->stft_imag && state->mel_filter);

    /* Walk the virtual stream = state->carry || pcm. */
    const size_t total = state->n_carry + n_samples;
    size_t cursor = 0;

    while (cursor + (size_t)WW_N_FFT <= total) {
        float window[WW_N_FFT];
        for (int i = 0; i < WW_N_FFT; ++i) {
            const size_t idx = cursor + (size_t)i;
            float sample = (idx < state->n_carry)
                ? state->carry[idx]
                : pcm[idx - state->n_carry];
            window[i] = sample;
        }

        float *col = out_columns + (*out_n_columns) * (size_t)WW_N_MELS;
        if (gguf_mode) {
            float mel_pow[WW_N_MELS];
            column_stft_to_mel_pow(state, window, mel_pow);
            for (int m = 0; m < WW_N_MELS; ++m) {
                float p = mel_pow[m] < WW_MEL_LOG_CLIP ? WW_MEL_LOG_CLIP : mel_pow[m];
                col[m] = 10.0f * log10f(p);
            }
        } else {
            column_legacy_log_mel(window, col);
        }
        (*out_n_columns)++;
        cursor += (size_t)WW_HOP_LEN;
    }

    /* Apply per-call relmax floor (GGUF mode only — matches openWakeWord ONNX). */
    if (gguf_mode && *out_n_columns > 0) {
        const size_t total_cells = (*out_n_columns) * (size_t)WW_N_MELS;
        float peak = out_columns[0];
        for (size_t i = 1; i < total_cells; ++i) {
            if (out_columns[i] > peak) peak = out_columns[i];
        }
        const float floor_db = peak - WW_MEL_DB_FLOOR;
        for (size_t i = 0; i < total_cells; ++i) {
            if (out_columns[i] < floor_db) out_columns[i] = floor_db;
        }
    }

    /* Stash unconsumed tail (clamped to WW_N_FFT - 1). */
    size_t new_carry_len = total - cursor;
    if (new_carry_len > (size_t)(WW_N_FFT - 1)) {
        const size_t drop = new_carry_len - (size_t)(WW_N_FFT - 1);
        cursor += drop;
        new_carry_len -= drop;
    }
    float new_carry[WW_N_FFT];
    for (size_t i = 0; i < new_carry_len; ++i) {
        const size_t idx = cursor + i;
        new_carry[i] = (idx < state->n_carry)
            ? state->carry[idx]
            : pcm[idx - state->n_carry];
    }
    memcpy(state->carry, new_carry, new_carry_len * sizeof(float));
    state->n_carry = new_carry_len;
    return 0;
}
