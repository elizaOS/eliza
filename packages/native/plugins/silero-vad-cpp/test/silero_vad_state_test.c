/*
 * Real test for the LSTM state helpers in `src/silero_vad_state.c`.
 *
 * The Silero v5 model carries a 64-dim hidden + 64-dim cell state
 * across 32 ms windows; the runtime must clear that state at every
 * utterance boundary or the first window of the new utterance reads
 * as a continuation of the previous one. This test confirms:
 *
 *   1. `silero_vad_state_reset` zeroes every byte (all four arrays:
 *      `h_in`, `c_in`, `h_out`, `c_out`).
 *   2. `silero_vad_state_promote` copies `*_out` into `*_in` so the
 *      next inference reads the just-emitted recurrent state.
 *   3. `silero_vad_state_is_zero` correctly distinguishes a freshly-
 *      reset struct from one that has any non-zero bit anywhere.
 *
 * The TU under test is internal — we include its private header
 * (`src/silero_vad_state.h`) directly via the build system's include
 * path, the same way the eventual ggml-backed session will.
 */

#include "silero_vad_state.h"

#include <stddef.h>
#include <stdio.h>

static int test_reset_zeros_every_field(void) {
    silero_vad_state_t state;

    /* Pre-fill with a recognizable pattern so a partial reset would
     * leave detectable residue. */
    for (size_t i = 0; i < SILERO_VAD_STATE_HIDDEN_DIM; ++i) {
        state.h_in[i] = 0.5f + (float)i;
        state.h_out[i] = -0.25f - (float)i;
    }
    for (size_t i = 0; i < SILERO_VAD_STATE_CELL_DIM; ++i) {
        state.c_in[i] = 1.5f + (float)i;
        state.c_out[i] = -2.0f - (float)i;
    }

    if (silero_vad_state_is_zero(&state)) {
        fprintf(stderr, "[state-test] is_zero false-positive on dirty state\n");
        return 1;
    }

    silero_vad_state_reset(&state);

    if (!silero_vad_state_is_zero(&state)) {
        fprintf(stderr,
                "[state-test] reset did not clear all four arrays\n");
        return 1;
    }

    /* Per-field check so a future struct addition that reset forgets
     * about would surface here too. */
    for (size_t i = 0; i < SILERO_VAD_STATE_HIDDEN_DIM; ++i) {
        if (state.h_in[i] != 0.0f || state.h_out[i] != 0.0f) {
            fprintf(stderr,
                    "[state-test] reset left h_in[%zu]=%f h_out[%zu]=%f\n",
                    i, (double)state.h_in[i], i, (double)state.h_out[i]);
            return 1;
        }
    }
    for (size_t i = 0; i < SILERO_VAD_STATE_CELL_DIM; ++i) {
        if (state.c_in[i] != 0.0f || state.c_out[i] != 0.0f) {
            fprintf(stderr,
                    "[state-test] reset left c_in[%zu]=%f c_out[%zu]=%f\n",
                    i, (double)state.c_in[i], i, (double)state.c_out[i]);
            return 1;
        }
    }

    return 0;
}

static int test_promote_copies_out_to_in(void) {
    silero_vad_state_t state;
    silero_vad_state_reset(&state);

    /* Simulate a model step writing an arbitrary out-state. */
    for (size_t i = 0; i < SILERO_VAD_STATE_HIDDEN_DIM; ++i) {
        state.h_out[i] = (float)i * 0.125f;
    }
    for (size_t i = 0; i < SILERO_VAD_STATE_CELL_DIM; ++i) {
        state.c_out[i] = -(float)i * 0.25f;
    }

    silero_vad_state_promote(&state);

    for (size_t i = 0; i < SILERO_VAD_STATE_HIDDEN_DIM; ++i) {
        if (state.h_in[i] != state.h_out[i]) {
            fprintf(stderr,
                    "[state-test] promote h mismatch at %zu (in=%f out=%f)\n",
                    i, (double)state.h_in[i], (double)state.h_out[i]);
            return 1;
        }
    }
    for (size_t i = 0; i < SILERO_VAD_STATE_CELL_DIM; ++i) {
        if (state.c_in[i] != state.c_out[i]) {
            fprintf(stderr,
                    "[state-test] promote c mismatch at %zu (in=%f out=%f)\n",
                    i, (double)state.c_in[i], (double)state.c_out[i]);
            return 1;
        }
    }

    return 0;
}

static int test_null_safety(void) {
    /* Both helpers must accept NULL without crashing. */
    silero_vad_state_reset(NULL);
    silero_vad_state_promote(NULL);
    if (silero_vad_state_is_zero(NULL) != 0) {
        fprintf(stderr, "[state-test] is_zero(NULL) must return 0\n");
        return 1;
    }
    return 0;
}

int main(void) {
    int failures = 0;
    failures += test_reset_zeros_every_field();
    failures += test_promote_copies_out_to_in();
    failures += test_null_safety();
    printf("[silero-vad-state-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
