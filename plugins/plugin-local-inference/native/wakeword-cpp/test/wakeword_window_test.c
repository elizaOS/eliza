/*
 * wakeword_window_test.c — sliding-window framing correctness.
 *
 * Strategy:
 *   - Generate 5 seconds of dummy mono 16 kHz PCM (a ramp so we can
 *     cross-check sample positions inside emitted frames).
 *   - Push it in 100 ms (1600-sample) chunks.
 *   - Assert the cumulative number of frames emitted after each
 *     chunk matches `floor(samples_pushed / WW_FRAME_SAMPLES)` —
 *     i.e. exactly one frame every 1280 samples = 80 ms.
 *   - Assert the contents of frame 0 are samples [0, 1280) of the
 *     ramp (no overlap, no offset).
 *   - Assert the contents of the last emitted frame match the
 *     expected sample window of the ramp (verifies no drift).
 */

#include "wakeword/wakeword.h"
#include "wakeword_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    int failures = 0;

    const size_t total = (size_t)WAKEWORD_SAMPLE_RATE * 5; /* 5 s = 80 000 samples */
    float *pcm = (float *)malloc(total * sizeof(float));
    if (!pcm) {
        fprintf(stderr, "[wakeword-window-test] OOM\n");
        return 1;
    }
    for (size_t i = 0; i < total; ++i) {
        pcm[i] = (float)i;
    }

    wakeword_window_state state;
    wakeword_window_state_init(&state);

    const size_t chunk = 1600; /* 100 ms */
    const size_t max_per_call = chunk / (size_t)WW_FRAME_SAMPLES + 1;
    float *out = (float *)malloc(max_per_call * (size_t)WW_FRAME_SAMPLES * sizeof(float));
    if (!out) {
        free(pcm);
        fprintf(stderr, "[wakeword-window-test] OOM\n");
        return 1;
    }

    size_t pushed = 0;
    uint64_t expected_total_frames_at_last_chunk = 0;
    /* Capture the very first frame so we can byte-compare it after the
     * full stream is consumed. */
    int captured_first = 0;
    float first_frame[WW_FRAME_SAMPLES];
    /* And the last emitted frame's start sample, to verify no drift. */
    uint64_t last_frame_index = 0;
    float last_frame[WW_FRAME_SAMPLES];

    while (pushed < total) {
        const size_t take = (total - pushed < chunk) ? (total - pushed) : chunk;
        size_t n_out = 0;
        const int rc = wakeword_window_push(&state, pcm + pushed, take, out,
                                            max_per_call, &n_out);
        if (rc != 0) {
            fprintf(stderr, "[wakeword-window-test] push returned %d\n", rc);
            ++failures;
            break;
        }
        pushed += take;
        const uint64_t expected_total = (uint64_t)(pushed / (size_t)WW_FRAME_SAMPLES);
        if (state.n_frames_emitted != expected_total) {
            fprintf(stderr,
                    "[wakeword-window-test] after %zu samples: emitted=%llu, expected=%llu\n",
                    pushed,
                    (unsigned long long)state.n_frames_emitted,
                    (unsigned long long)expected_total);
            ++failures;
        }
        expected_total_frames_at_last_chunk = expected_total;
        if (!captured_first && n_out > 0) {
            memcpy(first_frame, out, (size_t)WW_FRAME_SAMPLES * sizeof(float));
            captured_first = 1;
        }
        if (n_out > 0) {
            last_frame_index = state.n_frames_emitted - 1;
            memcpy(last_frame,
                   out + (n_out - 1) * (size_t)WW_FRAME_SAMPLES,
                   (size_t)WW_FRAME_SAMPLES * sizeof(float));
        }
    }

    /* 5 s / 80 ms = 62 full frames. */
    if (expected_total_frames_at_last_chunk != 62) {
        fprintf(stderr,
                "[wakeword-window-test] expected 62 frames over 5 s, got %llu\n",
                (unsigned long long)expected_total_frames_at_last_chunk);
        ++failures;
    }

    /* First frame should be [0, 1280). */
    if (captured_first) {
        for (int i = 0; i < WW_FRAME_SAMPLES; ++i) {
            if (first_frame[i] != (float)i) {
                fprintf(stderr,
                        "[wakeword-window-test] first frame sample[%d]=%.1f, expected %.1f\n",
                        i, (double)first_frame[i], (double)i);
                ++failures;
                break;
            }
        }
    } else {
        fprintf(stderr, "[wakeword-window-test] never captured a first frame\n");
        ++failures;
    }

    /* Last frame should start at last_frame_index * WW_FRAME_SAMPLES. */
    const float last_start = (float)(last_frame_index * (uint64_t)WW_FRAME_SAMPLES);
    for (int i = 0; i < WW_FRAME_SAMPLES; ++i) {
        const float expected = last_start + (float)i;
        if (last_frame[i] != expected) {
            fprintf(stderr,
                    "[wakeword-window-test] last frame sample[%d]=%.1f, expected %.1f\n",
                    i, (double)last_frame[i], (double)expected);
            ++failures;
            break;
        }
    }

    free(out);
    free(pcm);
    printf("[wakeword-window-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
