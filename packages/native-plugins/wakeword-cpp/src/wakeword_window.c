/*
 * wakeword_window.c — sliding-window framer that drips the streaming
 * 16 kHz PCM into back-to-back `WW_FRAME_SAMPLES`-long frames (80 ms,
 * 80 ms hop, no overlap).
 *
 * This is the *outer* hop schedule: one wake-classifier evaluation per
 * 80 ms of audio, matching the openWakeWord upstream cadence
 * (`wake-word.ts` constant `FRAME_SAMPLES = 1280`). The finer 10 ms
 * mel cadence the embedding model needs is owned by `wakeword_melspec`,
 * which runs inside the per-frame embedding TU when that lands in
 * Phase 2.
 *
 * The state buffers a partial frame between calls so callers can push
 * audio in arbitrary chunk sizes without worrying about boundaries.
 *
 * No defensive try/catch on the success path. Bad arguments return
 * `-EINVAL`. There is no other failure mode — the only state mutated
 * by a successful call is the buffer, the buffer length, and the
 * frame counter.
 */

#include "wakeword_internal.h"

#include <errno.h>
#include <string.h>

void wakeword_window_state_init(wakeword_window_state *state) {
    if (!state) return;
    memset(state, 0, sizeof(*state));
}

int wakeword_window_push(wakeword_window_state *state,
                         const float *pcm,
                         size_t n_samples,
                         float *out_frames,
                         size_t max_frames,
                         size_t *out_n_frames) {
    if (!state || !out_n_frames) return -EINVAL;
    if (n_samples > 0 && !pcm) return -EINVAL;
    if (max_frames > 0 && !out_frames) return -EINVAL;
    *out_n_frames = 0;

    size_t consumed = 0;
    while (consumed < n_samples) {
        const size_t need = (size_t)WW_FRAME_SAMPLES - state->n_buffered;
        const size_t avail = n_samples - consumed;
        const size_t take = avail < need ? avail : need;
        memcpy(state->buffer + state->n_buffered, pcm + consumed,
               take * sizeof(float));
        state->n_buffered += take;
        consumed += take;
        if (state->n_buffered == (size_t)WW_FRAME_SAMPLES) {
            if (*out_n_frames < max_frames) {
                memcpy(out_frames + (*out_n_frames) * (size_t)WW_FRAME_SAMPLES,
                       state->buffer,
                       (size_t)WW_FRAME_SAMPLES * sizeof(float));
                (*out_n_frames)++;
                state->n_frames_emitted++;
            } else {
                /* Caller's output buffer is full; drop the rest of the
                 * input on the floor. The caller is responsible for
                 * sizing `max_frames` to handle the chunk it pushed; in
                 * practice the streaming session over wakeword_process
                 * sizes it to the max produced by an 80 ms-aligned
                 * worst case. */
                state->n_buffered = 0;
                break;
            }
            /* Hop is exactly the frame size — no overlap to retain. */
            state->n_buffered = 0;
        }
    }
    return 0;
}
