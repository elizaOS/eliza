/*
 * Internal LSTM state struct + helpers for the Silero v5 VAD.
 *
 * Not part of the public ABI — the public surface only exposes
 * `silero_vad_reset_state(handle)` (clears the state inside the
 * opaque session). This header gives the eventual ggml-backed port
 * (and the unit tests in `test/silero_vad_state_test.c`) a typed
 * struct + a deterministic reset routine they can exercise without
 * a loaded model.
 *
 * Shape rationale: the Silero v5 graph carries a single LSTM layer
 * with 64-dim hidden + 64-dim cell state; the runtime threads the
 * "input" copy of each (the value the next inference reads) through
 * the model and writes the "output" copy back. Exposing both halves
 * lets the future ggml port keep the in/out separation explicit
 * without changing the public ABI.
 */

#ifndef SILERO_VAD_STATE_H
#define SILERO_VAD_STATE_H

#include "silero_vad/silero_vad.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float h_in[SILERO_VAD_STATE_HIDDEN_DIM];
    float c_in[SILERO_VAD_STATE_CELL_DIM];
    float h_out[SILERO_VAD_STATE_HIDDEN_DIM];
    float c_out[SILERO_VAD_STATE_CELL_DIM];
} silero_vad_state_t;

/*
 * Zero every field. Real implementation invariant: after a reset the
 * model must read the in-state as all zeros on the next window. The
 * port also calls this at session open so a fresh handle does not
 * inherit state from an unrelated previous run.
 */
void silero_vad_state_reset(silero_vad_state_t *state);

/*
 * Promote the just-written `*_out` arrays to the next inference's
 * `*_in` arrays. The eventual ggml port calls this between windows
 * so the LSTM advances its recurrent state in lock-step with the
 * input stream. Memory-safe with NULL (no-op).
 */
void silero_vad_state_promote(silero_vad_state_t *state);

/*
 * Return non-zero when every byte of the state is zero. Used by the
 * unit test to confirm `reset` actually clears all four arrays
 * rather than only one half.
 */
int silero_vad_state_is_zero(const silero_vad_state_t *state);

#ifdef __cplusplus
}
#endif

#endif /* SILERO_VAD_STATE_H */
