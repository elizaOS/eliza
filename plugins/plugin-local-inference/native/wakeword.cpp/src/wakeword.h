/*
 * wakeword.h — native openWakeWord streaming detector backed by GGML.
 *
 * Implements the `eliza_inference_wakeword_*` ABI declared in
 * `packages/app-core/scripts/omnivoice-fuse/ffi.h` (ABI v5). One
 * `eliza_wakeword_session_t` owns:
 *
 *   - the mmap of `<bundle_dir>/wake/openwakeword.gguf` and its parsed
 *     architectural metadata,
 *   - the bound classifier-head tensors for the selected phrase,
 *   - the streaming state: audio tail (480 samples), mel ring, embedding
 *     ring, and `frames_since_embedding` counter.
 *
 * The header is C-compatible (the public surface matches `ffi.h`); the
 * implementation in `wakeword.cpp` is C++ for ggml convenience.
 *
 * Status: scaffolding. The opaque session struct is defined, the GGUF
 * is loaded and validated, but the mel filterbank / speech embedding /
 * head kernels are all marked TODO. `score()` currently returns a hard
 * error so callers can't accidentally rely on a zero probability that
 * means "model not running". See README.md for the open work.
 */

#ifndef ELIZA_WAKEWORD_H
#define ELIZA_WAKEWORD_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Mirrors `ELIZA_OK` / `ELIZA_ERR_*` in ffi.h. We avoid pulling the full
 * ffi.h here so this header is consumable both from the fused build (which
 * has ffi.h on its include path) and a stand-alone tool. The values MUST
 * stay in lockstep. */
#define ELIZA_WAKEWORD_OK 0
#define ELIZA_WAKEWORD_ERR_NOT_IMPLEMENTED (-1)
#define ELIZA_WAKEWORD_ERR_INVALID_ARG (-2)
#define ELIZA_WAKEWORD_ERR_BUNDLE_INVALID (-3)
#define ELIZA_WAKEWORD_ERR_FFI_FAULT (-4)
#define ELIZA_WAKEWORD_ERR_OOM (-5)

/* Architectural constants — fixed by the upstream openWakeWord graphs
 * and the converter. The C runtime hard-checks the GGUF KV pairs against
 * these and refuses to open on mismatch (AGENTS.md §3 + §8: no silent
 * fallbacks). */
#define ELIZA_WAKEWORD_SAMPLE_RATE 16000
#define ELIZA_WAKEWORD_FRAME_SAMPLES 1280
#define ELIZA_WAKEWORD_MEL_LEAD_IN_SAMPLES 480
#define ELIZA_WAKEWORD_MEL_BINS 32
#define ELIZA_WAKEWORD_EMBEDDING_WINDOW_FRAMES 76
#define ELIZA_WAKEWORD_EMBEDDING_HOP_FRAMES 8
#define ELIZA_WAKEWORD_EMBEDDING_DIM 96
#define ELIZA_WAKEWORD_HEAD_WINDOW_EMBEDDINGS 16

/* Opaque session — one per detector instance. */
typedef struct eliza_wakeword_session eliza_wakeword_session_t;

/* Open a wake-word session.
 *
 * `gguf_path`     : absolute path to `wake/openwakeword.gguf` (the
 *                   combined mel + embedding + heads file produced by
 *                   `convert_openwakeword_to_gguf.py`).
 * `head_name`     : classifier head inside the GGUF (e.g. "hey-eliza").
 * `out_error`     : on failure, set to a heap-allocated NUL-terminated
 *                   diagnostic string; caller frees with the matching
 *                   `eliza_wakeword_free_string`. NULL on success.
 *
 * Returns the new session on success, NULL on failure. The fused build
 * forwards this to `eliza_inference_wakeword_open`. */
eliza_wakeword_session_t *
eliza_wakeword_open(const char * gguf_path, const char * head_name,
                    char ** out_error);

/* Score exactly one frame of 1280 fp32 mono samples at 16 kHz. Writes
 * the latest P(wake) in [0, 1] into `*out_probability`. Early frames
 * before enough context has accumulated MAY write 0. */
int eliza_wakeword_score(eliza_wakeword_session_t * session, const float * pcm,
                         size_t n_samples, float * out_probability,
                         char ** out_error);

/* Clear the streaming state (audio tail, mel ring, embedding ring,
 * frames-since-embedding counter). Cheap; safe to call as often as the
 * voice loop wants. */
int eliza_wakeword_reset(eliza_wakeword_session_t * session, char ** out_error);

/* Free a session. Idempotent on NULL. */
void eliza_wakeword_close(eliza_wakeword_session_t * session);

/* Free a NUL-terminated diagnostic string returned by this module.
 * Idempotent on NULL. */
void eliza_wakeword_free_string(char * str);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_WAKEWORD_H */
