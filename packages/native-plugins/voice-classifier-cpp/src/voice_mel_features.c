/*
 * voice-classifier-cpp — shared log-mel front-end.
 *
 * Computes a log-mel spectrogram with parameters fixed by the public
 * header:
 *
 *   sample_rate = VOICE_CLASSIFIER_SAMPLE_RATE_HZ (16000)
 *   n_fft       = VOICE_CLASSIFIER_N_FFT          (512)
 *   hop         = VOICE_CLASSIFIER_HOP            (160)
 *   n_mels      = VOICE_CLASSIFIER_N_MELS         (80)
 *
 * Pipeline per frame:
 *   1. Slice `n_fft` samples starting at `frame_index * hop`.
 *   2. Apply a periodic Hann window (matches numpy/torchaudio with
 *      `periodic=True`, the standard for ASR / VAD front-ends).
 *   3. Compute the magnitude spectrum via a naive DFT (real input,
 *      `n_fft / 2 + 1` complex outputs). 512-point at 16 kHz with hop
 *      160 puts us at 100 fps; the naive DFT is ~O(n²) per frame but
 *      stays well under the budget for the small windows the three
 *      heads consume (≤ ~3 s at a time). A real-FFT swap can drop in
 *      behind the same signature later — callers and the test suite
 *      depend only on the output values, not the implementation.
 *   4. Project onto an HTK-style triangular mel filterbank with edges
 *      from 0 Hz to sample_rate / 2 = 8 kHz, 80 filters.
 *   5. Take `log(max(magnitude_squared @ filterbank, eps))` to produce
 *      log-mel power. Most upstream emotion / EOT / speaker models
 *      expect log-mel power (not log-mel energy from the magnitude
 *      directly); converting to power before the log is the convention
 *      and it lines up with torchaudio's `MelSpectrogram + AmplitudeToDB`
 *      defaults.
 *
 * Filterbank precomputation is amortized across calls via a one-time
 * lazy-init guarded by a flag; the table is small (80 * (n_fft/2 + 1)
 * floats ~ 80 KB) and read-only after construction.
 *
 * No allocations on the hot path: scratch buffers (windowed frame, real
 * + imag DFT outputs, magnitude-squared) are stack-local in
 * `voice_mel_compute`. The mel filterbank is a static array.
 */

#include "voice_classifier/voice_classifier.h"

#include <errno.h>
#include <math.h>
#include <stddef.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define MEL_N_FFT     VOICE_CLASSIFIER_N_FFT
#define MEL_N_MELS    VOICE_CLASSIFIER_N_MELS
#define MEL_HOP       VOICE_CLASSIFIER_HOP
#define MEL_SR        VOICE_CLASSIFIER_SAMPLE_RATE_HZ
#define MEL_N_BINS    (MEL_N_FFT / 2 + 1)

/* log floor: avoids log(0) without distorting strong bins. Matches the
 * common torchaudio default of 1e-10 power. */
#define MEL_LOG_EPS 1e-10f

/* ---------------- precomputed tables ---------------- */

static int g_tables_ready = 0;
static float g_hann_window[MEL_N_FFT];
/* Mel filterbank: row-major [MEL_N_MELS][MEL_N_BINS]. Most rows are
 * mostly zero (only ~3-5 contiguous bins per filter contribute), but
 * the dense layout is tiny and enables a straight-line dot product per
 * frame. */
static float g_mel_filters[MEL_N_MELS * MEL_N_BINS];

static double hz_to_mel(double hz) {
    /* Slaney mel scale (matches librosa's `htk=False`). The HTK scale
     * (`2595 * log10(1 + hz/700)`) is also common; we pick Slaney
     * because it tracks human perception better at low frequencies and
     * the difference at 16 kHz is small. The conversion script must
     * agree on the same scale when packing model weights derived from a
     * trained mel pipeline. */
    const double f_min = 0.0;
    const double f_sp  = 200.0 / 3.0;
    const double min_log_hz  = 1000.0;
    const double min_log_mel = (min_log_hz - f_min) / f_sp;
    const double logstep = log(6.4) / 27.0;
    if (hz >= min_log_hz) {
        return min_log_mel + log(hz / min_log_hz) / logstep;
    }
    return (hz - f_min) / f_sp;
}

static double mel_to_hz(double mel) {
    const double f_min = 0.0;
    const double f_sp  = 200.0 / 3.0;
    const double min_log_hz  = 1000.0;
    const double min_log_mel = (min_log_hz - f_min) / f_sp;
    const double logstep = log(6.4) / 27.0;
    if (mel >= min_log_mel) {
        return min_log_hz * exp(logstep * (mel - min_log_mel));
    }
    return f_min + f_sp * mel;
}

static void build_tables(void) {
    if (g_tables_ready) return;

    /* Periodic Hann (`N` periodic = `N+1` symmetric truncated). The
     * common ASR convention. */
    for (int i = 0; i < MEL_N_FFT; ++i) {
        g_hann_window[i] =
            (float)(0.5 - 0.5 * cos((2.0 * M_PI * (double)i) / (double)MEL_N_FFT));
    }

    /* Mel filterbank edges: MEL_N_MELS + 2 mel-spaced points from 0 to
     * sr/2; each filter spans [edge[i], edge[i+1], edge[i+2]] and has
     * unit-area triangular response. Slaney normalization (divide by
     * the filter width in Hz) keeps low-frequency bands from
     * dominating — the standard for emotion / speaker pipelines. */
    const double f_min_hz = 0.0;
    const double f_max_hz = (double)MEL_SR / 2.0;
    const double mel_min  = hz_to_mel(f_min_hz);
    const double mel_max  = hz_to_mel(f_max_hz);

    double edges_hz[MEL_N_MELS + 2];
    for (int i = 0; i < MEL_N_MELS + 2; ++i) {
        const double mel = mel_min + (mel_max - mel_min) * (double)i / (double)(MEL_N_MELS + 1);
        edges_hz[i] = mel_to_hz(mel);
    }

    /* Precompute the bin centre frequencies. */
    double bin_freq_hz[MEL_N_BINS];
    for (int k = 0; k < MEL_N_BINS; ++k) {
        bin_freq_hz[k] = (double)k * (double)MEL_SR / (double)MEL_N_FFT;
    }

    memset(g_mel_filters, 0, sizeof(g_mel_filters));
    for (int m = 0; m < MEL_N_MELS; ++m) {
        const double left   = edges_hz[m];
        const double centre = edges_hz[m + 1];
        const double right  = edges_hz[m + 2];
        const double left_width  = centre - left;
        const double right_width = right - centre;
        /* Slaney area normalization: 2 / (right - left). Avoids tiny
         * filter weights at the bottom of the band. */
        const double area_norm = (right > left) ? 2.0 / (right - left) : 0.0;
        for (int k = 0; k < MEL_N_BINS; ++k) {
            const double f = bin_freq_hz[k];
            double w = 0.0;
            if (f >= left && f <= centre && left_width > 0.0) {
                w = (f - left) / left_width;
            } else if (f >= centre && f <= right && right_width > 0.0) {
                w = (right - f) / right_width;
            }
            g_mel_filters[m * MEL_N_BINS + k] = (float)(w * area_norm);
        }
    }

    g_tables_ready = 1;
}

/* Naive DFT for real input, length MEL_N_FFT. Writes magnitude-squared
 * (power) into `power_out[0 .. MEL_N_BINS - 1]`. The naive O(N²) cost
 * is fine for the small windows these three heads consume; a future
 * pass can swap in pocketfft / kissfft behind the same caller surface. */
static void real_dft_power(const float *x, float *power_out) {
    for (int k = 0; k < MEL_N_BINS; ++k) {
        double re = 0.0;
        double im = 0.0;
        const double phase_step = -2.0 * M_PI * (double)k / (double)MEL_N_FFT;
        for (int n = 0; n < MEL_N_FFT; ++n) {
            const double phase = phase_step * (double)n;
            re += (double)x[n] * cos(phase);
            im += (double)x[n] * sin(phase);
        }
        power_out[k] = (float)(re * re + im * im);
    }
}

/* ---------------- public API ---------------- */

size_t voice_mel_frame_count(size_t n_samples) {
    if (n_samples < (size_t)MEL_N_FFT) return 0;
    return 1 + (n_samples - (size_t)MEL_N_FFT) / (size_t)MEL_HOP;
}

int voice_mel_compute(const float *pcm_16khz,
                      size_t n_samples,
                      float *mel_out,
                      size_t mel_capacity,
                      size_t *frames_out) {
    if (frames_out == NULL) return -EINVAL;
    *frames_out = 0;
    if (pcm_16khz == NULL) return -EINVAL;
    if (n_samples < (size_t)MEL_N_FFT) return -EINVAL;

    build_tables();

    const size_t frames = voice_mel_frame_count(n_samples);
    *frames_out = frames;
    const size_t required = frames * (size_t)MEL_N_MELS;

    if (mel_out == NULL || mel_capacity < required) {
        return -ENOSPC;
    }

    float windowed[MEL_N_FFT];
    float power[MEL_N_BINS];

    for (size_t f = 0; f < frames; ++f) {
        const size_t offset = f * (size_t)MEL_HOP;
        for (int n = 0; n < MEL_N_FFT; ++n) {
            windowed[n] = pcm_16khz[offset + (size_t)n] * g_hann_window[n];
        }
        real_dft_power(windowed, power);
        float *row = mel_out + f * (size_t)MEL_N_MELS;
        for (int m = 0; m < MEL_N_MELS; ++m) {
            double acc = 0.0;
            const float *filter = g_mel_filters + m * MEL_N_BINS;
            for (int k = 0; k < MEL_N_BINS; ++k) {
                acc += (double)filter[k] * (double)power[k];
            }
            float v = (float)acc;
            if (v < MEL_LOG_EPS) v = MEL_LOG_EPS;
            row[m] = logf(v);
        }
    }

    return 0;
}
