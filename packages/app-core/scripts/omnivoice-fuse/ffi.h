/*
 * libelizainference FFI ABI v1.
 *
 * Single source of truth for the C-callable surface that the fused
 * omnivoice + llama.cpp build (`libelizainference.{dylib,so,dll}`)
 * exposes. Consumed today by the Node FFI loader at
 * `packages/app-core/src/services/local-inference/voice/ffi-bindings.ts`,
 * and intended to be consumed unchanged by the Capacitor (mobile) and
 * Electrobun (desktop) bridges as they come online.
 *
 * All entry points are `extern "C"` (no name mangling) so any FFI
 * loader (bun:ffi, node-ffi, koffi, JNI, Swift, Rust, Python) sees the
 * same symbol set. The shape was intentionally small + synchronous in
 * v1 to match Wave-4-C's lifecycle contract:
 *   - opaque context pointer, created from a bundle root
 *   - mmap acquire/evict for voice on/off
 *   - synchronous TTS / ASR forward passes.
 *
 * ABI v2 adds the streaming ASR session API
 * (`eliza_inference_asr_stream_open/feed/partial/finish/close`) so a
 * `StreamingTranscriber` (see voice/transcriber.ts) can feed PCM frames
 * and read a running partial transcript without buffering the whole
 * utterance JS-side. v2 additions are *additive symbols* — a v1 caller
 * is unaffected — but the version bumps so loaders can require v2 for
 * the streaming path. The batch `eliza_inference_asr_transcribe` stays
 * for one-shot callers.
 *
 * Errors are propagated via heap-allocated `char *` strings written to
 * `out_error` arguments; callers MUST free them with
 * `eliza_inference_free_string`. A NULL `out_error` parameter is a
 * programmer error (caller skipped diagnostics) and the library is
 * permitted to crash. Per AGENTS.md §3 + §9 the library never logs
 * and never returns a defaulted result on failure.
 *
 * Status codes are plain int. Successful calls return >= 0; failures
 * return one of the negative `ELIZA_*` constants below.
 */

#ifndef ELIZA_INFERENCE_FFI_H
#define ELIZA_INFERENCE_FFI_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- ABI version ---------------------------------------------------- */

/* Bump on any breaking shape change. The Node loader checks the value
 * returned by `eliza_inference_abi_version()` against this constant on
 * load and refuses to bind if they disagree. */
#define ELIZA_INFERENCE_ABI_VERSION 2

/* Returns a static, NUL-terminated string of the form "2" matching
 * ELIZA_INFERENCE_ABI_VERSION at the time the library was built. The
 * pointer is owned by the library — do NOT free. */
const char * eliza_inference_abi_version(void);

/* ---- Status codes --------------------------------------------------- */

/* Negative values reserved for failure. Callers MUST treat any negative
 * return as an error and read `*out_error` if provided. */
#define ELIZA_OK                   0
#define ELIZA_ERR_NOT_IMPLEMENTED -1   /* Stub or feature not present in this build */
#define ELIZA_ERR_INVALID_ARG     -2   /* NULL pointer where one was required, etc. */
#define ELIZA_ERR_BUNDLE_INVALID  -3   /* bundle_dir missing, manifest unreadable */
#define ELIZA_ERR_FFI_FAULT       -4   /* mmap/madvise/syscall failure */
#define ELIZA_ERR_OOM             -5   /* allocation failure */
#define ELIZA_ERR_ABI_MISMATCH    -6   /* loader vs library disagree */

/* ---- Lifecycle ------------------------------------------------------ */

/* Opaque context. One per active engine. */
typedef struct EliInferenceContext EliInferenceContext;

/* Create a new context anchored at `bundle_dir` (the on-disk bundle
 * root, see `packages/inference/AGENTS.md` §2 for the layout the
 * library expects). On failure returns NULL and writes a heap-allocated
 * diagnostic into `*out_error`. */
EliInferenceContext * eliza_inference_create(
    const char * bundle_dir,
    char ** out_error);

/* Destroy a context. Idempotent for NULL. After this returns, every
 * pointer derived from the context (mmap regions, output buffers
 * written into via the caller) is invalid. */
void eliza_inference_destroy(EliInferenceContext * ctx);

/* ---- Memory pressure / mmap ---------------------------------------- */

/* Voice on/off backing calls. Wave-4-C's `VoiceLifecycle` arms voice
 * by calling `mmap_acquire("tts")` + `mmap_acquire("asr")`, and disarms
 * by calling `mmap_evict(...)` on the same region names.
 *
 * `region_name` is a stable string in the set:
 *   - "tts"  : OmniVoice weights (mmap of tts/omnivoice-*.gguf)
 *   - "asr"  : ASR weights (mmap of asr/...)
 *   - "text" : text+vision weights (kept hot — always acquired)
 *   - "dflash" : drafter weights (kept hot — always acquired)
 *
 * Returns ELIZA_OK on success, negative on failure with
 * `*out_error` populated. Eviction is a hint to the OS (madvise
 * MADV_DONTNEED / VirtualUnlock) — it does NOT close the file
 * descriptor; a subsequent `mmap_acquire` re-pages without a fresh
 * open(). */
int eliza_inference_mmap_acquire(
    EliInferenceContext * ctx,
    const char * region_name,
    char ** out_error);

int eliza_inference_mmap_evict(
    EliInferenceContext * ctx,
    const char * region_name,
    char ** out_error);

/* ---- TTS forward (synchronous) ------------------------------------- */

/* Synthesize speech for the given UTF-8 text. The library writes up to
 * `max_samples` fp32 PCM samples into `out_pcm` (sample rate fixed at
 * 24 kHz to match the EngineVoiceBridge default).
 *
 * Returns the number of samples actually written (>= 0) on success, or
 * a negative ELIZA_* code on failure. If the buffer was too small the
 * library returns ELIZA_ERR_INVALID_ARG and reports the required size
 * in the diagnostic string. v1 has no streaming variant — chunking is
 * driven by the JS-side phrase chunker.
 *
 * `speaker_preset_id` may be NULL to use the bundle default. */
int eliza_inference_tts_synthesize(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    const char * speaker_preset_id,
    float * out_pcm,
    size_t max_samples,
    char ** out_error);

/* ---- ASR transcription (synchronous) ------------------------------- */

/* Transcribe `n_samples` fp32 PCM samples (mono) at `sample_rate_hz`.
 * The library writes a UTF-8 NUL-terminated transcript into `out_text`,
 * up to `max_text_bytes - 1` bytes plus the terminator.
 *
 * Returns the number of bytes written (excluding the terminator) on
 * success, or a negative ELIZA_* code on failure. */
int eliza_inference_asr_transcribe(
    EliInferenceContext * ctx,
    const float * pcm,
    size_t n_samples,
    int sample_rate_hz,
    char * out_text,
    size_t max_text_bytes,
    char ** out_error);

/* ---- Streaming ASR (ABI v2) --------------------------------------- *
 *
 * A streaming ASR session: feed PCM frames as they arrive (post-VAD-gate)
 * and read a running partial transcript between feeds. The library owns
 * the internal audio buffer + decoder state and runs windowed decode
 * passes; the JS side never re-submits earlier audio.
 *
 *   open  → feed* → partial* → finish → close
 *
 * `finish` force-finalizes (drains buffered audio, last decode pass) and
 * yields the final transcript; the session must still be `close`d after.
 * All calls return >= 0 on success or a negative ELIZA_* code with
 * `*out_error` populated. The token-id out-params (`out_tokens` /
 * `io_n_tokens`) are OPTIONAL — pass NULL to skip; when supplied, the
 * library writes up to `*io_n_tokens` text-model token ids for the
 * current transcript (the fused build shares the text vocabulary, so
 * these feed STT-finish token injection without re-tokenization) and
 * updates `*io_n_tokens` to the count actually written.
 */

/* Capability probe: returns 1 when this build has a working streaming ASR
 * decoder, 0 when it does not (stub / ASR-disabled build). Callers use
 * this to choose the streaming path vs an interim adapter WITHOUT having
 * to open a session and catch ELIZA_ERR_NOT_IMPLEMENTED. */
int eliza_inference_asr_stream_supported(void);

/* Opaque streaming-ASR session. One per active speech segment. */
typedef struct EliAsrStream EliAsrStream;

/* Open a streaming ASR session anchored to `ctx`. `sample_rate_hz` is the
 * rate of the PCM the caller will feed (the library resamples as needed).
 * Returns NULL on failure with `*out_error` populated. */
EliAsrStream * eliza_inference_asr_stream_open(
    EliInferenceContext * ctx,
    int sample_rate_hz,
    char ** out_error);

/* Feed `n_samples` fp32 mono PCM samples at the session's sample rate.
 * Returns the number of samples consumed (>= 0) on success, negative
 * ELIZA_* on failure. */
int eliza_inference_asr_stream_feed(
    EliAsrStream * stream,
    const float * pcm,
    size_t n_samples,
    char ** out_error);

/* Read the current running partial transcript. Writes a UTF-8
 * NUL-terminated string into `out_text` (up to `max_text_bytes - 1`
 * bytes + terminator); optionally writes token ids into `out_tokens`
 * (see header note). Returns the number of text bytes written (excluding
 * the terminator) on success, negative ELIZA_* on failure. */
int eliza_inference_asr_stream_partial(
    EliAsrStream * stream,
    char * out_text,
    size_t max_text_bytes,
    int * out_tokens,
    size_t * io_n_tokens,
    char ** out_error);

/* Drain remaining buffered audio, run a final decode pass, and write the
 * final transcript (same out args as `_partial`). The session is still
 * valid until `_close`. Returns text bytes written or negative ELIZA_*. */
int eliza_inference_asr_stream_finish(
    EliAsrStream * stream,
    char * out_text,
    size_t max_text_bytes,
    int * out_tokens,
    size_t * io_n_tokens,
    char ** out_error);

/* Close + free a streaming ASR session. Idempotent on NULL. */
void eliza_inference_asr_stream_close(EliAsrStream * stream);

/* ---- Memory ownership helpers -------------------------------------- */

/* Free a string the library allocated and handed out (error messages,
 * future transcript buffers). Safe on NULL. */
void eliza_inference_free_string(char * str);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_INFERENCE_FFI_H */
