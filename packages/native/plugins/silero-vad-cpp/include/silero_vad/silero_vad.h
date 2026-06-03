/*
 * Silero VAD — public C ABI for the standalone native plugin that ports
 * snakers4/silero-vad's small LSTM-based speech detector to the
 * elizaOS/llama.cpp ggml dispatcher, replacing the onnxruntime-node path
 * in `plugins/plugin-local-inference/src/services/voice/vad.ts`.
 *
 * Upstream:
 *   https://github.com/snakers4/silero-vad
 *   MIT licensed; ~1.7M parameter LSTM gate, ~2 MB model.
 *
 * This header is the interface the native CPU implementation satisfies.
 * Dispatcher upgrades may swap in ggml/Metal/NEON/AVX behind the same ABI.
 *
 * Audio convention:
 *   - Input PCM is mono, 32-bit float (`float`), samples in `[-1, 1]`.
 *   - The model expects 16 kHz audio. Callers running at a different
 *     sample rate must pre-resample with `silero_vad_resample_linear`
 *     (declared below) before calling `silero_vad_process`.
 *   - The native window the v5 graph consumes is 512 samples (32 ms @
 *     16 kHz). `silero_vad_process` accepts any window of that exact
 *     length and emits one speech-probability scalar in `[0, 1]`.
 *
 * State convention:
 *   - The session carries the LSTM hidden + cell state across calls.
 *   - `silero_vad_reset_state` clears that state; it must be called at
 *     utterance boundaries so a new utterance does not inherit context
 *     from the previous one.
 *
 * Threading:
 *   - Reentrant against distinct `silero_vad_handle`s.
 *   - Sharing one handle across threads is the caller's mutex problem.
 *
 * Error handling:
 *   - All entry points return `int`: zero on success, negative
 *     `errno`-style codes on failure (`-ENOENT` for missing GGUF,
 *     `-EINVAL` for shape/argument mismatch). No silent fallbacks.
 *   - On any non-zero return the function clears its out-parameters so
 *     the caller cannot accidentally read uninitialized memory.
 */

#ifndef SILERO_VAD_SILERO_VAD_H
#define SILERO_VAD_SILERO_VAD_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The model variant this header is dimensioned around. The GGUF
 * conversion script (`scripts/silero_vad_to_gguf.py`) emits a file
 * whose `silero_vad.variant` metadata key matches this string; the
 * runtime refuses to load any other variant.
 */
#define SILERO_VAD_VARIANT_V5    "silero_vad_v5"

/*
 * The native input window length in samples. The Silero v5 graph only
 * accepts 512-sample windows at 16 kHz (32 ms hop). Any other size is
 * an `-EINVAL` from `silero_vad_process`.
 */
#define SILERO_VAD_WINDOW_SAMPLES_16K 512

/*
 * The model's required input sample rate, in Hz. Callers must
 * resample mic audio to this rate before calling `silero_vad_process`.
 */
#define SILERO_VAD_SAMPLE_RATE_HZ 16000

/*
 * LSTM hidden / cell state width. The Silero v5 graph carries a single
 * recurrent layer with 128-dim hidden and 128-dim cell state (the ONNX
 * model's `state` input is shaped `[2, B, 128]` — first slab is `h`,
 * second is `c`). The state object exposed via `silero_vad_state.c`
 * packs both as flat `float[128]` arrays.
 */
#define SILERO_VAD_STATE_HIDDEN_DIM 128
#define SILERO_VAD_STATE_CELL_DIM   128

/* Opaque handle to a loaded VAD session. The implementation owns the
 * loaded ggml graph, scratch buffers, and per-session LSTM state. */
typedef struct silero_vad_session *silero_vad_handle;

/* ---------------- session lifecycle ---------------- */

/*
 * Open a Silero VAD session against a GGUF file produced by
 * `scripts/silero_vad_to_gguf.py`. Writes the new handle into `*out`.
 *
 * Returns 0 on success.
 * Returns `-ENOENT` if `gguf_path` does not name a readable file.
 * Returns `-EINVAL` if `out` is NULL or the GGUF's `silero_vad.variant`
 *   metadata key does not match `SILERO_VAD_VARIANT_V5`.
 * On failure `*out` (when non-NULL) is set to NULL.
 */
int silero_vad_open(const char *gguf_path, silero_vad_handle *out);

/*
 * Clear the session's LSTM hidden + cell state. Call at the start of
 * every new utterance — without it the model carries acoustic context
 * from the previous utterance and the first window of the new
 * utterance reads as a continuation.
 *
 * Returns 0 on success, `-EINVAL` for a NULL handle.
 */
int silero_vad_reset_state(silero_vad_handle h);

/*
 * Run the model over a single 512-sample window of 16 kHz mono float
 * PCM and write the speech probability into `*speech_prob_out`.
 *
 * `pcm_16khz` must point to exactly `n_samples` 32-bit floats; the
 * runtime requires `n_samples == SILERO_VAD_WINDOW_SAMPLES_16K`.
 * Caller-side resampling (e.g. via `silero_vad_resample_linear`) is
 * the responsibility of the audio front-end.
 *
 * Returns 0 on success and writes a value in `[0, 1]` into
 * `*speech_prob_out`.
 * Returns `-EINVAL` on NULL handle, NULL `speech_prob_out`, NULL
 * `pcm_16khz`, or wrong window size.
 * On failure `*speech_prob_out` (when non-NULL) is set to 0.
 */
int silero_vad_process(silero_vad_handle h,
                       const float *pcm_16khz,
                       size_t n_samples,
                       float *speech_prob_out);

/*
 * Release a session. NULL-safe (a NULL handle is a no-op success).
 *
 * Returns 0 on success.
 */
int silero_vad_close(silero_vad_handle h);

/* ---------------- utility ---------------- */

/*
 * Linear resample `n_in` samples of mono float PCM from `src_rate_hz`
 * to `dst_rate_hz`, writing the result into `dst`. Returns the number
 * of samples written on success, or a negative `errno`-style code:
 *
 *   `-EINVAL` for a NULL pointer, zero/negative rate, or zero input
 *             length;
 *   `-ENOSPC` if `dst_capacity` is smaller than the required output
 *             size (the required size is `ceil(n_in * dst_rate_hz /
 *             src_rate_hz)`);
 *   `-ENOMEM` only if the implementation's internal allocation fails
 *             (reserved for higher-order resamplers if they are added).
 *
 * The implementation performs simple linear interpolation between adjacent
 * input samples — adequate for the VAD's needs (we only need an unbiased
 * probability gate, not studio-grade fidelity).
 *
 * When `src_rate_hz == dst_rate_hz` this function is a memcpy: it
 * still validates arguments but copies the input verbatim.
 */
int silero_vad_resample_linear(const float *src,
                               size_t n_in,
                               int src_rate_hz,
                               float *dst,
                               size_t dst_capacity,
                               int dst_rate_hz);

/* ---------------- diagnostics ---------------- */

/*
 * Capability string of the active backend. Reflects the runtime-selected
 * dispatch path. The native CPU implementation returns "native-cpu".
 * Dispatcher-backed implementations may return "ggml-cpu", "ggml-metal",
 * etc. Never NULL.
 */
const char *silero_vad_active_backend(void);

#ifdef __cplusplus
}
#endif

#endif /* SILERO_VAD_SILERO_VAD_H */
