/*
 * silero-vad-cpp — LSTM hidden/cell state management.
 *
 * Pure C, no external dependencies. The public ABI only exposes
 * `silero_vad_reset_state(handle)`, which calls `silero_vad_state_reset`
 * against the state struct inside `silero_vad_session`. The unit test
 * (`test/silero_vad_state_test.c`) exercises `reset`, `promote`, and
 * `is_zero` directly.
 */

#include "silero_vad_state.h"

#include <stddef.h>
#include <string.h>

void silero_vad_state_reset(silero_vad_state_t *state) {
    if (state == NULL) {
        return;
    }
    memset(state, 0, sizeof(*state));
}

void silero_vad_state_promote(silero_vad_state_t *state) {
    if (state == NULL) {
        return;
    }
    memcpy(state->h_in, state->h_out, sizeof(state->h_in));
    memcpy(state->c_in, state->c_out, sizeof(state->c_in));
}

int silero_vad_state_is_zero(const silero_vad_state_t *state) {
    if (state == NULL) {
        return 0;
    }
    const unsigned char *bytes = (const unsigned char *)state;
    for (size_t i = 0; i < sizeof(*state); ++i) {
        if (bytes[i] != 0) {
            return 0;
        }
    }
    return 1;
}
