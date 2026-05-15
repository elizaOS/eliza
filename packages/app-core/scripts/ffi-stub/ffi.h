/*
 * libelizainference FFI ABI v4.
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
 * ABI v2 is the streaming voice surface. It adds:
 *   - the streaming ASR session API
 *     (`eliza_inference_asr_stream_open/feed/partial/finish/close`) so a
 *     `StreamingTranscriber` (see voice/transcriber.ts) can feed PCM
 *     frames and read a running partial transcript without buffering the
 *     whole utterance JS-side;
 *   - streaming TTS (`eliza_inference_tts_synthesize_stream` +
 *     `eliza_inference_cancel_tts` + `eliza_inference_tts_stream_supported`)
 *     so OmniVoice emits PCM chunks as they decode and the JS scheduler
 *     can phrase-chunk → TTS within one scheduler tick and hard-cancel an
 *     in-flight forward pass on barge-in (AGENTS.md §4);
 *   - the native DFlash verifier callback
 *     (`eliza_inference_set_verifier_callback`) so the JS scheduler drives
 *     phrase-chunking + rollback off exact native accept/reject events
 *     from the fork's speculative loop, not synthesized SSE deltas.
 * All ABI v2 additions are *additive symbols* — a v1 caller is
 * unaffected — but the version bumps so loaders can require v2 for the
 * streaming path. The batch `eliza_inference_asr_transcribe` and
 * `eliza_inference_tts_synthesize` stay for one-shot callers.
 *
 * ABI v3 adds the native Silero VAD surface:
 *   - the "vad" mmap region for VAD weights / runtime pages;
 *   - `eliza_inference_vad_supported/open/process/reset/close`, matching
 *     the JS Silero contract: 16 kHz, 512-sample windows, one speech
 *     probability per window.
 *
 * ABI v4 adds the OmniVoice frozen-voice preset surface:
 *   - the runtime resolves `speaker_preset_id` against
 *     `<bundle_dir>/cache/voice-preset-<id>.bin` (ELZ2 v2) on every TTS
 *     call and applies the persisted `(instruct, ref_audio_tokens, ref_T,
 *     ref_text)` triple to `ov_tts_params`. v3 callers that passed
 *     `speaker_preset_id == NULL` (auto-voice) keep that behaviour;
 *     `speaker_preset_id == "default"` / `"sam"` / etc. now resolve
 *     to a real preset file instead of being misread as a VoiceDesign
 *     attribute string.
 *   - `eliza_inference_encode_reference` is added so the freeze CLI can
 *     pre-encode a reference WAV's HuBERT+RVQ tokens once and persist
 *     them in the preset file. Symbol is additive — v3 callers that
 *     don't use it are unaffected.
 *
 * ABI v5 adds the native openWakeWord surface — the GGML/llama.cpp
 * replacement for the previous `onnxruntime-node`-backed wake-word path:
 *   - the "wakeword" mmap region for the combined wake-word GGUF
 *     (melspectrogram filterbank + speech embedding model + per-phrase
 *     head, all in one file under `wake/openwakeword.gguf`);
 *   - `eliza_inference_wakeword_supported/open/score/reset/close`,
 *     matching the JS openWakeWord contract: 16 kHz mono fp32 PCM,
 *     1280-sample frames (80 ms), one P(wake) per frame in [0, 1];
 *   - `head_name` selects which classifier head inside the GGUF gets
 *     bound at `_open` time (e.g. "hey-eliza").
 * v4 callers that never touched the wake-word entries are unaffected.
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
#define ELIZA_INFERENCE_ABI_VERSION 5

/* Returns a static, NUL-terminated string of the form "4" matching
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
#define ELIZA_ERR_CANCELLED       -7   /* caller requested cancellation (chunk cb / cancel_tts) */

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
 *   - "vad" : Silero VAD weights / runtime pages
 *   - "wakeword" : openWakeWord combined GGUF (mel filterbank + speech
 *     embedding model + per-phrase head)
 *
 * Returns ELIZA_OK on success, negative on failure with
 * `*out_error` populated. Implementations may either issue an OS paging
 * hint (madvise MADV_DONTNEED / VirtualUnlock) or fully unload the
 * voice-only region to minimize voice-off RSS. Callers must treat an
 * evicted region as unavailable until a later `mmap_acquire(region)`.
 * The "text" and "dflash" regions are allowed to be no-ops because the
 * text runtime keeps them hot for voice-off text turns. */
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

/* ---- Streaming TTS (ABI v2) --------------------------------------- *
 *
 * Chunked synthesis: the library decodes the codec frames for `text` and
 * invokes `on_chunk` with each decoded PCM segment as it becomes
 * available (24 kHz fp32 mono, same rate as `eliza_inference_tts_synthesize`),
 * then once more with `is_final == 1` and a zero-length tail to mark the
 * end of the utterance. This lets the JS phrase-chunker hand a phrase to
 * TTS and start playback before the whole forward pass finishes
 * (AGENTS.md §4 — phrase-chunk → TTS within one scheduler tick).
 *
 * `on_chunk` returning non-zero requests cancellation: the library stops
 * the decode at the next kernel boundary and returns
 * ELIZA_ERR_CANCELLED. It is still called once more with `is_final == 1`
 * (n_samples may be 0) so the consumer can release per-utterance state.
 * The `pcm` pointer is owned by the library and is only valid for the
 * duration of the `on_chunk` call — copy it out before returning.
 *
 * `speaker_preset_id` may be NULL to use the bundle default. Returns
 * ELIZA_OK on a clean finish, ELIZA_ERR_CANCELLED when `on_chunk`
 * requested a stop, or a negative ELIZA_* code on failure with
 * `*out_error` populated. */
typedef int (*eliza_tts_chunk_cb)(
    const float * pcm,
    size_t n_samples,
    int is_final,
    void * user_data);

/* Capability probe: 1 only when this build wires real decoded PCM chunk
 * callbacks and the cooperative `eliza_inference_cancel_tts` path, 0 when
 * it does not (stub / TTS-disabled build). Mirrors
 * `eliza_inference_asr_stream_supported`. Callers pick the streaming path
 * vs the batch `eliza_inference_tts_synthesize` off this flag — they do
 * not have to call the streaming entry and catch ELIZA_ERR_NOT_IMPLEMENTED. */
int eliza_inference_tts_stream_supported(void);

int eliza_inference_tts_synthesize_stream(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    const char * speaker_preset_id,
    eliza_tts_chunk_cb on_chunk,
    void * user_data,
    char ** out_error);

/* Hard-cancel any TTS forward pass currently in flight on `ctx` (the
 * one started by `eliza_inference_tts_synthesize` /
 * `eliza_inference_tts_synthesize_stream` on another thread). The
 * in-flight call returns ELIZA_ERR_CANCELLED at the next kernel
 * boundary. Returns ELIZA_OK whether or not a forward pass was running
 * (cancelling nothing is not an error). */
int eliza_inference_cancel_tts(
    EliInferenceContext * ctx,
    char ** out_error);

/* ---- OmniVoice reference encode (ABI v4) -------------------------- *
 *
 * Encode a 24 kHz mono fp32 PCM buffer through the OmniVoice tokenizer
 * (HuBERT semantic encoder + RVQ codec) and return the resulting
 * reference-audio-token tensor `[K=8, ref_T]` as int32 row-major.
 *
 * This is the encode-only half of the TTS pipeline that the freeze CLI
 * (`packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs`) uses to
 * persist a same-locked preset under
 * `<bundle_dir>/cache/voice-preset-same.bin`. At runtime the
 * synthesis path reads the preset back and feeds the persisted tokens
 * into `params.ref_audio_tokens` — there is no per-utterance encode
 * cost.
 *
 * On success the library writes:
 *   - `*out_K`     : number of codebooks (always 8 for OmniVoice)
 *   - `*out_ref_T` : number of frames per codebook
 *   - `out_tokens` : `*out_K * *out_ref_T` int32 values, row-major
 *                    `tokens[k * ref_T + t]`. The buffer is allocated by
 *                    the library via malloc; callers MUST release it via
 *                    `eliza_inference_free_tokens` (a thin wrapper around
 *                    `free`). A NULL `out_tokens` parameter is a
 *                    programmer error.
 *
 * The TTS region must have been acquired (`mmap_acquire("tts")`) before
 * the call — the same OmniVoice context is reused. Returns ELIZA_OK on
 * success, negative ELIZA_* on failure with `*out_error` populated.
 *
 * `sample_rate_hz` must be 24000 today; passing a different rate returns
 * ELIZA_ERR_INVALID_ARG with a diagnostic. The library does not resample
 * on this entrypoint to keep the freeze artifact deterministic — the
 * caller is responsible for upstream resampling to 24 kHz mono fp32. */
int eliza_inference_encode_reference(
    EliInferenceContext * ctx,
    const float * pcm,
    size_t n_samples,
    int sample_rate_hz,
    int * out_K,
    int * out_ref_T,
    int ** out_tokens,
    char ** out_error);

/* Free a token buffer the library returned from
 * `eliza_inference_encode_reference`. Safe on NULL. */
void eliza_inference_free_tokens(int * tokens);

/* ---- DFlash verifier callback (ABI v2) ---------------------------- *
 *
 * The fused runtime hosts the dflash drafter in-process (`-md <drafter>`)
 * and runs the fork's speculative accept/reject loop directly. Register
 * a callback here and the runtime fires `ev` for every speculative step:
 *   - `accepted_token_ids` / `n_accepted` — the draft tokens the target
 *     verified this step (committed to the sequence);
 *   - `rejected_from` / `rejected_to` — the half-open token-index range
 *     of the draft tail the verifier rejected this step (both -1 when
 *     nothing was rejected this step);
 *   - `corrected_token_ids` / `n_corrected` — the target's resampled
 *     tokens that replace the rejected tail (empty when nothing was
 *     rejected).
 * Token-index domain is the *output* stream (token 0 = first generated
 * token), matching the `RejectedTokenRange` the JS rollback queue uses.
 * The `*_token_ids` arrays are owned by the library and only valid for
 * the duration of the callback — copy out before returning.
 *
 * Passing `cb == NULL` clears a previously-registered callback. Only one
 * callback is active per context; re-registering replaces it. The
 * callback is invoked on the generation thread, synchronously between
 * decode steps — keep it cheap (enqueue, don't block). */
typedef struct {
    const int * accepted_token_ids;
    size_t n_accepted;
    int rejected_from;
    int rejected_to;
    const int * corrected_token_ids;
    size_t n_corrected;
} EliVerifierEvent;

typedef void (*eliza_verifier_cb)(
    const EliVerifierEvent * ev,
    void * user_data);

int eliza_inference_set_verifier_callback(
    EliInferenceContext * ctx,
    eliza_verifier_cb cb,
    void * user_data,
    char ** out_error);

/* ---- Native VAD (ABI v3) ------------------------------------------ *
 *
 * Native Silero VAD backend. The shape intentionally mirrors
 * `voice/vad.ts::SileroVad`: 16 kHz mono fp32 PCM, 512-sample windows,
 * one probability in [0, 1] per call, and recurrent state reset at
 * utterance boundaries. The JS binding chooses this backend when
 * `eliza_inference_vad_supported() == 1`; otherwise it falls back to the
 * ONNX runtime path unchanged.
 */

/* Capability probe: 1 when this build implements native VAD, 0 when it
 * does not (stub / VAD-disabled build). */
int eliza_inference_vad_supported(void);

/* Opaque native VAD session. One per detector. */
typedef struct EliVad EliVad;

/* Open a VAD session anchored to `ctx`. `sample_rate_hz` must be 16000
 * for the Silero v5-compatible ABI. Returns NULL on failure with
 * `*out_error` populated. */
EliVad * eliza_inference_vad_open(
    EliInferenceContext * ctx,
    int sample_rate_hz,
    char ** out_error);

/* Process exactly one 512-sample fp32 mono window and write its speech
 * probability into `*out_probability`. Returns ELIZA_OK on success or a
 * negative ELIZA_* code on failure. */
int eliza_inference_vad_process(
    EliVad * vad,
    const float * pcm,
    size_t n_samples,
    float * out_probability,
    char ** out_error);

/* Clear recurrent model state at utterance boundaries. */
int eliza_inference_vad_reset(
    EliVad * vad,
    char ** out_error);

/* Close + free a native VAD session. Idempotent on NULL. */
void eliza_inference_vad_close(EliVad * vad);

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

/* ---- Native wake-word (ABI v5) ------------------------------------ *
 *
 * Native openWakeWord backend. The shape mirrors
 * `voice/wake-word.ts::OpenWakeWordModel`: a streaming pipeline over
 * 16 kHz mono fp32 PCM in 1280-sample frames (80 ms). The library owns
 * the three sub-models (mel filterbank, speech embedding model, head)
 * and all the intermediate ring buffers (audio tail, mel ring,
 * embedding ring); the JS side feeds one 1280-sample frame per call
 * and reads back the most recent P(wake) in [0, 1].
 *
 * The weights live in one combined GGUF at
 * `<bundle_dir>/wake/openwakeword.gguf` (see
 * `packages/training/scripts/wakeword/convert_openwakeword_to_gguf.py`).
 * `head_name` selects which classifier head inside that GGUF is bound
 * at session open (e.g. "hey-eliza"). The JS binding chooses this
 * backend unconditionally — there is no ONNX fallback. */

/* Capability probe: 1 when this build implements native wake-word
 * detection (mel filterbank + speech embedding + head wired against
 * the combined GGUF), 0 when it does not (stub / wake-word-disabled
 * build). The JS binding throws a structured "wake-word runtime not
 * ready in this build" error when this returns 0 — no silent
 * fallback (AGENTS.md §3, §8). */
int eliza_inference_wakeword_supported(void);

/* Opaque native wake-word session. One per detector instance. */
typedef struct EliWakeWord EliWakeWord;

/* Open a wake-word session anchored to `ctx`. `sample_rate_hz` MUST be
 * 16000 (openWakeWord is fixed to 16 kHz mono). `head_name` is a
 * NUL-terminated UTF-8 string naming the classifier head inside the
 * combined wake-word GGUF (e.g. "hey-eliza"); the library resolves it
 * against the head tensors stored in the GGUF and binds the matching
 * one for the lifetime of the session. Returns NULL on failure with
 * `*out_error` populated (unknown head, mismatched embedding dim,
 * missing weights, etc.). */
EliWakeWord * eliza_inference_wakeword_open(
    EliInferenceContext * ctx,
    int sample_rate_hz,
    const char * head_name,
    char ** out_error);

/* Score exactly one 1280-sample fp32 mono frame at 16 kHz. The library
 * appends the frame to its internal audio buffer, runs as many
 * embedding hops + head passes as became due, and writes the latest
 * P(wake) into `*out_probability`. Early frames before enough context
 * accumulates write 0. Returns ELIZA_OK on success or a negative
 * ELIZA_* code on failure. */
int eliza_inference_wakeword_score(
    EliWakeWord * wake,
    const float * pcm,
    size_t n_samples,
    float * out_probability,
    char ** out_error);

/* Clear all internal state at the start of a fresh listening session.
 * Drops the audio tail, mel ring and embedding ring; future frames are
 * scored as if the detector had just been opened. Returns ELIZA_OK or
 * a negative ELIZA_* code. */
int eliza_inference_wakeword_reset(
    EliWakeWord * wake,
    char ** out_error);

/* Close + free a native wake-word session. Idempotent on NULL. */
void eliza_inference_wakeword_close(EliWakeWord * wake);

/* ---- Memory ownership helpers -------------------------------------- */

/* Free a string the library allocated and handed out (error messages,
 * future transcript buffers). Safe on NULL. */
void eliza_inference_free_string(char * str);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_INFERENCE_FFI_H */
