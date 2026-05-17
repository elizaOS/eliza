/*
 * silero-vad-cpp — LSTM hidden/cell state management.
 *
 * Pure C, no external dependencies. The public ABI only exposes
 * `silero_vad_reset_state(handle)` — once the ggml-backed port lands
 * it will call `silero_vad_state_reset` against the state struct that
 * lives inside its `silero_vad_session`. Until then this TU is also
 * the source of the unit-test-visible behaviour: the test
 * (`test/silero_vad_state_test.c`) exercises `reset`, `promote`, and
 * `is_zero` directly so the contract is validated even while the
 * model surface is stubbed.
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
