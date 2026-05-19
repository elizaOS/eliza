/*
 * wakeword-cpp — public C ABI for the standalone native plugin that
 * ports the openWakeWord (Apache-2.0, https://github.com/dscripka/openWakeWord)
 * three-stage streaming pipeline (melspectrogram → embedding → classifier
 * head) off `onnxruntime-node` and onto the elizaOS/llama.cpp ggml
 * dispatcher.
 *
 * The TypeScript reference implementation that this library is replacing
 * lives at:
 *   plugins/plugin-local-inference/src/services/voice/wake-word.ts
 *
 * That file is read-only for this port — it documents the contract.
 *
 * Three GGUFs are loaded per session, mirroring openWakeWord's three
 * ONNX graphs:
 *   1. melspec   — 16 kHz PCM → log-mel frames. Pure C; no ggml weights.
 *   2. embedding — small CNN over a sliding mel window → 96-dim embedding.
 *   3. classifier — small MLP over a 16-embedding window → P(wake) ∈ [0,1].
 *
 * Streaming contract (the only mode this header exposes):
 *   - The caller drips 16 kHz mono float PCM into `wakeword_process`.
 *   - The library buffers internally and runs the three stages on its own
 *     hop schedule.
 *   - On every call, `*score_out` is the most recent classifier
 *     probability. Early calls (before enough mel + embedding context has
 *     accumulated) return 0.
 *
 * Threading: reentrant against distinct `wakeword_handle` values. Sharing
 * one handle across threads is the caller's mutex problem.
 *
 * Error handling: every entry point returns `int` — zero on success,
 * negative `errno`-style codes on failure. The stub returns `-ENOSYS`.
 *
 * No silent fallbacks. A missing GGUF, a bad shape, or a corrupt graph
 * surfaces as a structured error, never as a "best effort 0.0".
 */

#ifndef WAKEWORD_WAKEWORD_H
#define WAKEWORD_WAKEWORD_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Sample rate the streaming pipeline expects. Anything else is `-EINVAL`. */
#define WAKEWORD_SAMPLE_RATE 16000

/* Default detection threshold (matches openWakeWord upstream). */
#define WAKEWORD_DEFAULT_THRESHOLD 0.5f

/* Opaque session handle. The implementation owns the loaded ggml graphs,
 * the rolling PCM tail, the mel ring, the embedding ring, and the most
 * recent classifier probability. Always passed by value. */
typedef struct wakeword_session *wakeword_handle;

/* ---------------- session lifecycle ---------------- */

/*
 * Load a wake-word session from three GGUF files: the melspectrogram
 * front-end, the audio→embedding model, and the wake-phrase classifier.
 *
 * Writes the new handle into `*out` on success. On failure, `*out` is
 * cleared to NULL and a negative errno-style code is returned.
 *
 * Returns:
 *   0          — session opened.
 *   -ENOSYS    — stub build (no real backend wired).
 *   -EINVAL    — NULL `out`, or NULL/empty path.
 *   -ENOENT    — one of the GGUFs is missing on disk.
 *   -EIO       — a GGUF failed to load (corrupt header, version mismatch).
 */
int wakeword_open(const char *melspec_gguf,
                  const char *embedding_gguf,
                  const char *classifier_gguf,
                  wakeword_handle *out);

/*
 * Release a session. Safe to call with NULL. After this call the handle
 * value is invalid and must not be passed to any other entry point.
 */
int wakeword_close(wakeword_handle h);

/* ---------------- streaming inference ---------------- */

/*
 * Push `n_samples` of 16 kHz mono float PCM (in [-1, 1]) into the
 * session and write the most recent classifier probability into
 * `*score_out`. Early calls (before enough mel + embedding context has
 * accumulated) write 0.
 *
 * `n_samples` is the count of float samples in `pcm_16khz`, not bytes,
 * not frames. The library internally hops on a fixed 80 ms chunk
 * boundary; passing arbitrary lengths is fine.
 *
 * Returns:
 *   0          — score was written.
 *   -ENOSYS    — stub build.
 *   -EINVAL    — NULL handle, NULL pcm pointer with non-zero count, or
 *                NULL `score_out`.
 */
int wakeword_process(wakeword_handle h,
                     const float *pcm_16khz,
                     size_t n_samples,
                     float *score_out);

/*
 * Set the detection threshold used by higher-level callers that want a
 * boolean fired/not-fired view. The score returned by `wakeword_process`
 * is unaffected — this is purely advisory state stored on the session
 * for callers that read it back via a future `wakeword_get_threshold`.
 *
 * `threshold` must be in [0, 1]. Default on `wakeword_open` is
 * `WAKEWORD_DEFAULT_THRESHOLD` (0.5).
 */
int wakeword_set_threshold(wakeword_handle h, float threshold);

/* ---------------- diagnostics ---------------- */

/*
 * Capability string of the active backend. The stub returns `"stub"`;
 * the real impl returns `"ggml-cpu"`, `"ggml-metal"`, etc. Must not be
 * freed by the caller.
 */
const char *wakeword_active_backend(void);

#ifdef __cplusplus
}
#endif

#endif /* WAKEWORD_WAKEWORD_H */
