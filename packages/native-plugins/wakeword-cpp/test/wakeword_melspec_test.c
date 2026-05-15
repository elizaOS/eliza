/*
 * wakeword_melspec_test.c — spectral correctness check for the
 * pure-C log-mel spectrogram.
 *
 * Strategy:
 *   - Synthesize 1 second of a 1 kHz sine wave at 16 kHz (16 000
 *     samples).
 *   - Stream it through `wakeword_melspec_stream`.
 *   - For each emitted column, find the mel bin with the highest
 *     log-energy. Assert the modal bin across columns has its centre
 *     frequency within ±100 Hz of 1 kHz.
 *   - Stream a second tone at 4 kHz and assert the modal bin sits
 *     above the 1 kHz one (sanity: high-frequency tone → high mel
 *     bin, low-frequency tone → low mel bin).
 *
 * If both spectral checks pass, the Hann + DFT + mel filter bank
 * cannot be silently broken (a wrong mel-Hz mapping would scramble
 * the modal bin; a wrong DFT would scatter energy uniformly; a wrong
 * Hann would still give the right peak — that is fine, the parity
 * test is about the spectral structure).
 */

#include "wakeword/wakeword.h"
#include "wakeword_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static void synthesize_tone(float *out, size_t n, float hz) {
    const float w = 2.0f * (float)M_PI * hz / (float)WAKEWORD_SAMPLE_RATE;
    for (size_t i = 0; i < n; ++i) {
        out[i] = sinf(w * (float)i);
    }
}

static int modal_mel_bin(const float *columns, size_t n_cols) {
    int counts[WW_N_MELS];
    memset(counts, 0, sizeof(counts));
    for (size_t c = 0; c < n_cols; ++c) {
        const float *col = columns + c * (size_t)WW_N_MELS;
        int best = 0;
        float best_v = col[0];
        for (int m = 1; m < WW_N_MELS; ++m) {
            if (col[m] > best_v) {
                best_v = col[m];
                best = m;
            }
        }
        counts[best]++;
    }
    int best = 0;
    int best_count = counts[0];
    for (int m = 1; m < WW_N_MELS; ++m) {
        if (counts[m] > best_count) {
            best_count = counts[m];
            best = m;
        }
    }
    return best;
}

int main(void) {
    int failures = 0;

    const size_t n = (size_t)WAKEWORD_SAMPLE_RATE; /* 1 s */
    float *pcm = (float *)malloc(n * sizeof(float));
    if (!pcm) {
        fprintf(stderr, "[wakeword-melspec-test] OOM\n");
        return 1;
    }

    /* Output buffer big enough for the worst case across both runs. */
    const size_t max_cols = wakeword_melspec_max_columns(n);
    float *cols = (float *)malloc(max_cols * (size_t)WW_N_MELS * sizeof(float));
    if (!cols) {
        free(pcm);
        fprintf(stderr, "[wakeword-melspec-test] OOM\n");
        return 1;
    }

    /* --- 1 kHz tone --- */
    synthesize_tone(pcm, n, 1000.0f);
    wakeword_melspec_state s1;
    wakeword_melspec_state_init(&s1);
    size_t n_cols_1 = 0;
    int rc = wakeword_melspec_stream(&s1, pcm, n, cols, &n_cols_1);
    if (rc != 0) {
        fprintf(stderr, "[wakeword-melspec-test] stream(1kHz) returned %d\n", rc);
        ++failures;
    }
    if (n_cols_1 == 0) {
        fprintf(stderr, "[wakeword-melspec-test] stream(1kHz) produced 0 columns\n");
        ++failures;
    }
    const int modal_1k = modal_mel_bin(cols, n_cols_1);
    const float center_1k = wakeword_mel_bin_center_hz(modal_1k);
    if (fabsf(center_1k - 1000.0f) > 100.0f) {
        fprintf(stderr,
                "[wakeword-melspec-test] 1kHz tone: modal bin=%d (center=%.1f Hz),"
                " expected center within ±100 Hz of 1000 Hz\n",
                modal_1k, (double)center_1k);
        ++failures;
    } else {
        printf("[wakeword-melspec-test] 1kHz: modal bin=%d (center=%.1f Hz) OK\n",
               modal_1k, (double)center_1k);
    }

    /* --- 4 kHz tone --- */
    synthesize_tone(pcm, n, 4000.0f);
    wakeword_melspec_state s2;
    wakeword_melspec_state_init(&s2);
    size_t n_cols_2 = 0;
    rc = wakeword_melspec_stream(&s2, pcm, n, cols, &n_cols_2);
    if (rc != 0) {
        fprintf(stderr, "[wakeword-melspec-test] stream(4kHz) returned %d\n", rc);
        ++failures;
    }
    if (n_cols_2 == 0) {
        fprintf(stderr, "[wakeword-melspec-test] stream(4kHz) produced 0 columns\n");
        ++failures;
    }
    const int modal_4k = modal_mel_bin(cols, n_cols_2);
    const float center_4k = wakeword_mel_bin_center_hz(modal_4k);
    if (fabsf(center_4k - 4000.0f) > 400.0f) {
        fprintf(stderr,
                "[wakeword-melspec-test] 4kHz tone: modal bin=%d (center=%.1f Hz),"
                " expected center within ±400 Hz of 4000 Hz\n",
                modal_4k, (double)center_4k);
        ++failures;
    } else {
        printf("[wakeword-melspec-test] 4kHz: modal bin=%d (center=%.1f Hz) OK\n",
               modal_4k, (double)center_4k);
    }

    if (modal_4k <= modal_1k) {
        fprintf(stderr,
                "[wakeword-melspec-test] mel ordering broken: 4kHz bin %d <= 1kHz bin %d\n",
                modal_4k, modal_1k);
        ++failures;
    }

    /* --- single-column convenience entry point --- */
    float window[WW_N_FFT];
    synthesize_tone(window, (size_t)WW_N_FFT, 1000.0f);
    float mel[WW_N_MELS];
    rc = wakeword_melspec_column(window, mel);
    if (rc != 0) {
        fprintf(stderr, "[wakeword-melspec-test] melspec_column returned %d\n", rc);
        ++failures;
    }
    int single_best = 0;
    float single_best_v = mel[0];
    for (int m = 1; m < WW_N_MELS; ++m) {
        if (mel[m] > single_best_v) { single_best_v = mel[m]; single_best = m; }
    }
    const float single_center = wakeword_mel_bin_center_hz(single_best);
    if (fabsf(single_center - 1000.0f) > 100.0f) {
        fprintf(stderr,
                "[wakeword-melspec-test] single-column 1kHz: modal bin=%d (%.1f Hz)\n",
                single_best, (double)single_center);
        ++failures;
    }

    free(cols);
    free(pcm);
    printf("[wakeword-melspec-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
