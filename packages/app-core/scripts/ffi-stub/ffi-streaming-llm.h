/*
 * libelizainference streaming-LLM FFI ABI.
 *
 * Additive surface on top of the v3 omnivoice ABI declared in `ffi.h`. The
 * symbols here are what `dflash-server.ts`'s in-process replacement
 * (`packages/app-core/src/services/local-inference/ffi-streaming-runner.ts`)
 * expects to find on the loaded `libelizainference.{dylib,so}` when it asks
 * `llmStreamSupported()`. They replace the previous "spawn `llama-server`
 * as a child process on the phone and stream over loopback HTTP" approach:
 *
 *   - Stock Android sandbox forbids forking arbitrary executables out of
 *     the APK private dir on most OEM builds.
 *   - App Store review forbids spawning sub-processes on iOS.
 *   - The HTTP round-trip per token costs ~10–30 ms on a phone — that
 *     dwarfs the latency speculative decoding is meant to save.
 *   - Slot save / slot restore for cross-launch KV reuse is not portable
 *     into the APK / IPA sandbox over a Unix socket.
 *
 * Keeping the surface synchronous + token-id based (NOT chat-completion
 * shaped) gives the JS scheduler the same accept/reject + cancel handles
 * the HTTP path exposed, with one less serialization layer.
 *
 * Header co-version: ABI v3 (omnivoice + native-VAD).  These streaming
 * symbols are guarded behind `eliza_inference_llm_stream_supported()` so a
 * library built from an older fused checkout can still load — the runner
 * falls back to the HTTP `llama-server` path on desktop only.  Mobile
 * builds require these symbols and surface a hard error when absent
 * (`buildDflashAdapter` in `aosp-dflash-adapter.ts`).
 *
 * Error / status conventions match `ffi.h`:
 *   - non-negative return = success (typical: `ELIZA_OK` or count written).
 *   - negative return = one of the `ELIZA_ERR_*` codes from `ffi.h`.
 *   - `out_error` is heap-allocated UTF-8, owned by the caller; free with
 *     `eliza_inference_free_string`.  A NULL `out_error` argument is a
 *     programmer error — the library is permitted to crash.
 *
 * CMake integration:
 *   - The fused build (`build-llama-cpp-dflash.mjs` + `cmake-graft.mjs`)
 *     adds `omnivoice/src/streaming_llm.cpp` (or equivalent) into the
 *     `elizainference` SHARED target.  Symbols declared here are exported
 *     with `__attribute__((visibility("default")))` on POSIX and
 *     `__declspec(dllexport)` on Windows under the `ELIZA_INFERENCE_BUILD`
 *     compile define (mirroring how `ffi.h` handles export visibility for
 *     the rest of the surface).
 *   - The implementation must NOT include `httplib.h` or any networking
 *     header — the whole point is to drop the in-process HTTP server.  It
 *     drives `common/speculative.cpp`'s loop directly against an in-process
 *     drafter + target loaded by `eliza_inference_create`.
 *
 * Threading:
 *   - `eliza_inference_llm_stream_open` / `_close` are caller-side cheap;
 *     `_prefill` / `_generate` block the calling thread on the decode loop.
 *   - The single-flight rule (one in-flight generate per pinned slot) is
 *     enforced by the JS runner (`FfiStreamingRunner.slotInFlight`).  The
 *     library MAY assume the caller respects that and is free to crash on
 *     overlap; it MUST NOT silently interleave KV state between concurrent
 *     calls against the same slot.
 *   - `eliza_inference_llm_stream_cancel` may be called from a different
 *     thread.  The in-flight generate / prefill returns
 *     `ELIZA_ERR_CANCELLED` at the next kernel boundary.
 */

#ifndef ELIZA_INFERENCE_FFI_STREAMING_LLM_H
#define ELIZA_INFERENCE_FFI_STREAMING_LLM_H

#include <stddef.h>
#include <stdint.h>

#include "ffi.h" /* EliInferenceContext, ELIZA_OK / ELIZA_ERR_* */

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Capability probe -------------------------------------------- *
 *
 * 1 only when this build wires real streaming-LLM forward passes and the
 * cooperative cancel path.  0 when it does not (stub / LLM-streaming-disabled
 * build).  Loaders use this to choose between the in-process FFI path
 * and the legacy HTTP `llama-server` path (desktop only — mobile requires
 * the FFI path). */
int eliza_inference_llm_stream_supported(void);

/* ---- Per-session config ------------------------------------------ *
 *
 * Passed by reference into `eliza_inference_llm_stream_open`.  Mirrored
 * 1:1 by `LlmStreamConfig` in
 * `packages/app-core/src/services/local-inference/voice/ffi-bindings.ts`,
 * which serialises this into a Bun `ArrayBuffer` via `ffi.ptr(buf)`.
 *
 * `slot_id` may be -1 to disable slot pinning; otherwise the runtime
 * pins prompt-cache + KV pages to that slot for cross-call reuse.
 *
 * `prompt_cache_key` is optional (NULL ok) and used by the runtime when
 * `slot_id` is -1 to derive a slot.  When non-NULL it MUST be a stable
 * NUL-terminated UTF-8 string the caller owns for the duration of the
 * `_open` call; the library copies it internally.
 *
 * `dflash_drafter_path` is the absolute on-disk path of the drafter GGUF.
 * NULL disables speculative decoding for this session.  `draft_min` and
 * `draft_max` bound the per-step draft length; both `0` also disables
 * speculative decoding.
 *
 * `disable_thinking` (1/0) is a passthrough for the Qwen3-style "thinking"
 * tag.  When set the runtime forbids sampling `<think>` tokens.  This is
 * a soft preference; 0 keeps the model's native behaviour. */
typedef struct {
    int32_t max_tokens;
    float   temperature;
    float   top_p;
    int32_t top_k;
    float   repeat_penalty;
    int32_t slot_id;
    const char * prompt_cache_key;   /* NULL ok */
    int32_t draft_min;
    int32_t draft_max;
    const char * dflash_drafter_path;/* NULL disables speculative */
    int32_t disable_thinking;        /* 0/1 */
} eliza_llm_stream_config_t;

/* ---- Session lifecycle ------------------------------------------- *
 *
 * Opaque streaming-LLM session.  One per active generation.  The session
 * owns the prompt-cache slot binding, the per-call sampling chain, and
 * the speculative-decoding state (if `dflash_drafter_path` is set). */
typedef struct eliza_llm_stream_session eliza_llm_stream_session_t;

/* Open a session anchored to `ctx`.  Returns NULL on failure with
 * `*out_error` populated.  The session must be `_close`d exactly once. */
eliza_llm_stream_session_t * eliza_inference_llm_stream_open(
    EliInferenceContext * ctx,
    const eliza_llm_stream_config_t * cfg,
    char ** out_error);

/* Feed pre-tokenized prompt tokens to the session BEFORE the first
 * `_generate` call.  `token_ids` is `num_tokens` int32s in
 * caller-allocated memory; the library copies what it needs (it does
 * not hold the pointer after return).  Returns `ELIZA_OK` on success or
 * a negative `ELIZA_ERR_*` code on failure. */
int eliza_inference_llm_stream_prefill(
    eliza_llm_stream_session_t * sess,
    const int32_t * token_ids,
    size_t num_tokens,
    char ** out_error);

/* ---- Streaming generation ---------------------------------------- *
 *
 * The token callback is invoked once per accepted token (or once per
 * accepted *batch* in the speculative-decoding case — see note below).
 *
 *   - `token_id` is the text-model token id.
 *   - `token_text` is the detokenized UTF-8 piece for that token,
 *     NUL-terminated, owned by the library; valid only for the duration
 *     of the call.  Copy it out before returning.
 *   - `user_data` is the opaque pointer the caller passed to `_generate`.
 *
 * Returning non-zero from `on_token` requests cancellation at the next
 * kernel boundary.  The library finishes the current decode step and
 * returns `ELIZA_ERR_CANCELLED` from `_generate`.
 *
 * Speculative decoding note: when DFlash is active the runtime commits
 * accepted draft tokens in a batch.  The library calls `on_token` once
 * per accepted token id (in stream order); the JS-side runner reconstructs
 * per-step batches by counting the calls between successive returns of
 * `_generate`.  The richer accept/reject decomposition (verifier events)
 * is delivered separately through `eliza_inference_set_verifier_callback`
 * declared in `ffi.h` (ABI v2).
 *
 * `max_tokens` caps the number of NEW tokens emitted by this call.  EOS
 * (or an EOG token, per `llama_vocab_is_eog`) also terminates generation
 * and is signalled by the caller via a normal return (last `on_token`
 * call carries the EOS piece if the vocab renders it as text).  Callers
 * MUST treat reaching `max_tokens` as a soft "running out of room" cap
 * — generation can be resumed by another `_generate` call on the same
 * session.
 */
typedef int (*eliza_llm_token_callback)(
    int32_t token_id,
    const char * token_text,
    void * user_data);

int eliza_inference_llm_stream_generate(
    eliza_llm_stream_session_t * sess,
    int32_t max_tokens,
    eliza_llm_token_callback on_token,
    void * user_data,
    char ** out_error);

/* ---- Cancellation ------------------------------------------------ *
 *
 * Hard-cancel any `_prefill` / `_generate` currently in flight on `sess`
 * (started by another thread).  The in-flight call returns
 * `ELIZA_ERR_CANCELLED` at the next kernel boundary.  Returns `ELIZA_OK`
 * whether or not a forward pass was running (cancelling nothing is not
 * an error).  Safe to call from a signal-handler-style context: it
 * publishes a flag and returns immediately. */
int eliza_inference_llm_stream_cancel(eliza_llm_stream_session_t * sess);

/* ---- Slot KV persistence ----------------------------------------- *
 *
 * Save / restore the session's slot KV state to disk for cross-launch
 * KV reuse (mobile background → resume).  Best called between generates;
 * calling mid-stream is racy and the library is permitted to refuse
 * with `ELIZA_ERR_INVALID_ARG`. */
int eliza_inference_llm_stream_save_slot(
    eliza_llm_stream_session_t * sess,
    const char * filename,
    char ** out_error);

int eliza_inference_llm_stream_restore_slot(
    eliza_llm_stream_session_t * sess,
    const char * filename,
    char ** out_error);

/* Close + free a streaming-LLM session.  Idempotent on NULL. */
void eliza_inference_llm_stream_close(eliza_llm_stream_session_t * sess);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_INFERENCE_FFI_STREAMING_LLM_H */
