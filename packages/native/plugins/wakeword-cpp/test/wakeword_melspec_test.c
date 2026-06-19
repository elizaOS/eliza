/*
 * wakeword_melspec_test.c — spectral correctness check for the legacy
 * (no-GGUF) C-side log-mel front-end. The runtime path replaces the
 * filter bank with an upstream openWakeWord one loaded from
 * `melspec.gguf` — that path is exercised by `wakeword_runtime_test`,
 * not here.
 *
 * Strategy:
 *   - Synthesize 1 second of a 1 kHz sine and a 4 kHz sine at 16 kHz.
 *   - Stream each through `wakeword_melspec_stream` in legacy mode
 *     (NULL tensors) — the state falls back to the in-process 80-mel
 *     0–8000 Hz bank, then bins down to 32 columns for output uniformity.
 *   - For each tone, find the modal output bin's centre frequency in
 *     the underlying 80-mel grid (via `wakeword_mel_bin_center_hz`).
 *     Assert the 1 kHz tone's modal centre lands within ±150 Hz of
 *     1 kHz, and the 4 kHz tone's modal centre lands within ±450 Hz of
 *     4 kHz, with the 4 kHz centre strictly higher than the 1 kHz one.
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

/* Modal bin index across the columns. The C melspec emits 32-wide
 * columns (legacy mode bins down from 80→32 by averaging contiguous
 * 80-mel chunks), so the modal index is in [0, 32). */
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

/* Map a 32-output-bin index to the centre frequency of its
 * underlying 80-mel chunk centre. The legacy bank reduces 80→32 by
 * averaging contiguous chunks (lo..hi exclusive); we report the
 * chunk's middle bin's centre. */
static float bin32_to_centre_hz(int bin32) {
    const int lo = (bin32 * WW_LEGACY_N_MELS) / WW_N_MELS;
    const int hi = ((bin32 + 1) * WW_LEGACY_N_MELS) / WW_N_MELS;
    const int mid = (lo + hi) / 2;
    return wakeword_mel_bin_center_hz(mid);
}

int main(void) {
    int failures = 0;

    const size_t n = (size_t)WAKEWORD_SAMPLE_RATE; /* 1 s */
    float *pcm = (float *)malloc(n * sizeof(float));
    if (!pcm) { fprintf(stderr, "[wakeword-melspec-test] OOM\n"); return 1; }

    const size_t max_cols = wakeword_melspec_max_columns(n);
    float *cols = (float *)malloc(max_cols * (size_t)WW_N_MELS * sizeof(float));
    if (!cols) { free(pcm); fprintf(stderr, "[wakeword-melspec-test] OOM\n"); return 1; }

    /* --- 1 kHz tone --- */
    synthesize_tone(pcm, n, 1000.0f);
    wakeword_melspec_state s1;
    wakeword_melspec_state_init(&s1, NULL, NULL, NULL); /* legacy */
    size_t n_cols_1 = 0;
    int rc = wakeword_melspec_stream(&s1, pcm, n, cols, &n_cols_1);
    if (rc != 0 || n_cols_1 == 0) {
        fprintf(stderr, "[wakeword-melspec-test] stream(1kHz) rc=%d cols=%zu\n", rc, n_cols_1);
        ++failures;
    }
    const int modal_1k = modal_mel_bin(cols, n_cols_1);
    const float center_1k = bin32_to_centre_hz(modal_1k);
    if (fabsf(center_1k - 1000.0f) > 150.0f) {
        fprintf(stderr,
                "[wakeword-melspec-test] 1kHz: modal bin=%d (centre≈%.1f Hz),"
                " expected within ±150 Hz of 1000 Hz\n",
                modal_1k, (double)center_1k);
        ++failures;
    } else {
        printf("[wakeword-melspec-test] 1kHz: modal bin=%d centre≈%.1f Hz OK\n",
               modal_1k, (double)center_1k);
    }

    /* --- 4 kHz tone --- */
    synthesize_tone(pcm, n, 4000.0f);
    wakeword_melspec_state s2;
    wakeword_melspec_state_init(&s2, NULL, NULL, NULL);
    size_t n_cols_2 = 0;
    rc = wakeword_melspec_stream(&s2, pcm, n, cols, &n_cols_2);
    if (rc != 0 || n_cols_2 == 0) {
        fprintf(stderr, "[wakeword-melspec-test] stream(4kHz) rc=%d cols=%zu\n", rc, n_cols_2);
        ++failures;
    }
    const int modal_4k = modal_mel_bin(cols, n_cols_2);
    const float center_4k = bin32_to_centre_hz(modal_4k);
    if (fabsf(center_4k - 4000.0f) > 450.0f) {
        fprintf(stderr,
                "[wakeword-melspec-test] 4kHz: modal bin=%d (centre≈%.1f Hz),"
                " expected within ±450 Hz of 4000 Hz\n",
                modal_4k, (double)center_4k);
        ++failures;
    } else {
        printf("[wakeword-melspec-test] 4kHz: modal bin=%d centre≈%.1f Hz OK\n",
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
    rc = wakeword_melspec_column(&s1, window, mel);
    if (rc != 0) {
        fprintf(stderr, "[wakeword-melspec-test] melspec_column rc=%d\n", rc);
        ++failures;
    }

    free(cols);
    free(pcm);
    printf("[wakeword-melspec-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
