/*
 * libelizainference FFI ABI v18.
 *
 * (Banner tracks ELIZA_INFERENCE_ABI_VERSION below; the per-version history is
 * at the end of this header preamble, newest first.)
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
 *     `speaker_preset_id == "default"` / `"samantha"` / etc. now resolve
 *     to a real preset file instead of being misread as a VoiceDesign
 *     attribute string.
 *   - `eliza_inference_encode_reference` is added so the freeze CLI can
 *     pre-encode a reference WAV's HuBERT+RVQ tokens once and persist
 *     them in the preset file. Symbol is additive — v3 callers that
 *     don't use it are unaffected.
 *
 * ABI v5 adds the native wake-word surface (already consumed by the
 * Bun loader in `ffi-bindings.ts`):
 *   - `eliza_inference_wakeword_supported/open/score/reset/close`,
 *     mirroring the openWakeWord three-stage streaming pipeline
 *     (melspec → embedding → classifier head): 16 kHz mono fp32,
 *     1280-sample (80 ms) frames, one P(wake) in [0, 1] per call,
 *     streaming state reset at utterance boundaries. The fused build
 *     resolves the three head GGUFs
 *     (`<bundle_dir>/wake/<head>.{melspec,embedding,classifier}.gguf`)
 *     from the context bundle + the head name passed at open.
 *
 * ABI v6 fuses the remaining standalone voice classifiers into the
 * single libelizainference handle so the whole voice pipeline runs
 * through one native lib (replaces the separate
 * `libvoice_classifier.{so,dylib}` standalone). Both additions own a
 * context-anchored session and call the vendored scalar-C forward
 * graphs under `tools/omnivoice/src/voice-classifiers/`:
 *   - `eliza_inference_speaker_supported/open/embed/free/close` — the
 *     WeSpeaker ResNet34-LM 256-d speaker-embedding encoder. 16 kHz
 *     mono fp32 in, one L2-normalized 256-float embedding out, for
 *     cosine-distance speaker matching.
 *   - `eliza_inference_diariz_supported/open/segment/close` — the
 *     pyannote-segmentation-3.0 diarizer. A fixed 80000-sample (5 s)
 *     16 kHz mono fp32 window in, a per-frame powerset-label sequence
 *     (293 int8 labels, one per frame) out.
 * All v5/v6 additions are additive symbols — a v4 caller is
 * unaffected — but the version bumps so loaders can require the new
 * surfaces. Older fused builds that report a lower version are still
 * usable at degraded capability via the per-symbol `*_supported()`
 * probes.
 *
 * ABI v7 promotes the native Silero VAD surface (the v3 symbols
 * `eliza_inference_vad_supported/open/process/reset/close`) from a stub
 * (`vad_supported() == 0`, every entry returned NOT_IMPLEMENTED) to a
 * real backend. It fuses the last standalone voice runtime — the
 * Silero v5 LSTM speech detector — into libelizainference, replacing
 * the separate `libsilero_vad.{so,dylib}` standalone, so all FOUR voice
 * classifiers (VAD, wake-word, speaker, diarizer) now run through one
 * fused handle. The wrapper owns a context-anchored session, resolves
 * the Silero GGUF from `<bundle_dir>/vad/` (conventionally
 * `silero-vad-v5.gguf`), and drives the vendored scalar-C forward graph
 * under `tools/omnivoice/src/voice-classifiers/vad/`. No new symbols are
 * added — `vad_supported()` simply now returns 1 and the four entries do
 * real work — so a v3..v6 caller that already bound the VAD surface
 * gains a working backend with no recompile. The version bumps so
 * loaders can require a build whose `vad_supported()` is real.
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
#include <stdint.h> /* int32_t in eliza_llm_stream_config_t + streaming-LLM ABI */

#ifdef __cplusplus
extern "C" {
#endif

/* ---- ABI version ---------------------------------------------------- */

/* Bump on any breaking shape change. The Node loader checks the value
 * returned by `eliza_inference_abi_version()` against this constant on
 * load and refuses to bind if they disagree.
 *
 * Changelog:
 *   v18: text-model context capacity resolved before stream admission.
 *         - `eliza_inference_llm_context_capacity(ctx, requested_context,
 *           n_gpu_layers, &out_capacity, &err)` loads the resident text model
 *           (if needed) and returns the context size `llm_stream_open` would
 *           use: `requested_context`, else ELIZA_LLM_N_CTX, else 8192, clamped
 *           to the GGUF training context. No decode context is allocated.
 *         - `llm_stream_open` now shares that resolution and rejects a
 *           non-positive capacity instead of creating a zero-sized context.
 *       Additive symbol; no existing signature changes. A v17 library lacks
 *       the symbol, so loaders must treat it as absent.
 *   v17: Paradee-8M TTS with native misaki G2P, plus cancellation and
 *       eviction for every TTS head and for ASR. All additions are new
 *       symbols; no existing signature changes.
 *         - `eliza_inference_paradee_supported/load/sample_rate/g2p_kind/
 *           phonemize/synthesize_alloc/synthesize_phonemes_alloc`. Built
 *           with `ELIZA_ENABLE_PARADEE` (TARGETs paradee_lib + misaki_g2p).
 *           Text goes through the native misaki lexicon, is split into
 *           <= 510-id chunks, and the PCM is concatenated. PCM is released
 *           with `eliza_inference_free_pcm`.
 *         - `eliza_inference_cancel_tts` now also stops in-flight Kokoro and
 *           Paradee synthesis (ELIZA_ERR_CANCELLED). Paradee polls the flag
 *           inside its graph and between chunks; Kokoro checks it before and
 *           after the forward pass (kokoro_lib has no in-graph hook).
 *         - `eliza_inference_asr_cancel` + `eliza_inference_asr_supported`.
 *           Cancel is an atomic flag (no asr_mutex), checked by the llama
 *           abort callback during prefill/decode, between mtmd chunks, and
 *           before every decode token.
 *         - `mmap_evict("tts")` frees Kokoro and Paradee (+ lexicon) as well
 *           as OmniVoice, keeping their paths; the next synth or
 *           `mmap_acquire("tts")` reloads them. `mmap_acquire("tts")` on a
 *           bundle without OmniVoice weights succeeds when a Kokoro or
 *           Paradee head is configured on the ctx.
 *         - The OmniVoice GGUF picker skips `tts/paradee/` and `paradee*`
 *           files, as it already skipped `tts/kokoro/`.
 *       Streaming ASR (`asr_stream_*`) is unchanged and still reports
 *       `asr_stream_supported() == 0`.
 *   v16: context-local text-model GPU selection
 *       (`eliza_inference_create_with_options`).
 *   v15: Kokoro synthesis can return an exact-size, library-owned PCM buffer
 *       through `eliza_inference_kokoro_synthesize_alloc` and
 *       `eliza_inference_kokoro_synthesize_ipa_alloc`; callers release it with
 *       `eliza_inference_free_pcm`. This removes guessed duration ceilings and
 *       avoids running the model twice to discover an output size.
 *   v14: Kokoro IPA input + G2P-kind capability query.
 *        `eliza_inference_kokoro_g2p_kind()` reports whether the linked
 *        kokoro_lib phonemizes raw text with real espeak-ng
 *        (ELIZA_KOKORO_G2P_ESPEAK) or only the lossy per-byte ASCII fallback
 *        (ELIZA_KOKORO_G2P_ASCII). `eliza_inference_kokoro_synthesize_ipa()`
 *        takes precomputed espeak-ng IPA and routes it through the fixed Kokoro
 *        vocab (`ipa_to_token_ids`), bypassing the in-lib phonemizer — the
 *        intelligible path for espeak-less Android / iOS / host builds, fed by
 *        the TS espeak-ng-WASM phonemizer (#11776). Before this, an espeak-less
 *        fused build phonemized raw text with the ASCII grapheme fallback and
 *        produced speech-shaped but unintelligible audio on every mobile build
 *        and any host without libespeak-ng. Additive symbols — a v12/v13 caller
 *        is unaffected; a library that predates this surface reports the symbols
 *        absent and the loader falls back to the raw-text path.
 *        NOTE ON NUMBERING: v13 (token-by-token vision describe) is the
 *        main-lineage vision surface. This develop-pinned lineage (fork-sync
 *        #11386) advances 12 -> 14 for the Kokoro IPA surface so the two
 *        independent bumps stay collision-free through reconciliation.
 *   v12: ASR word timestamps folded into the fused ASR.
 *        `eliza_inference_asr_timestamps_supported()` + `_asr_transcribe_timed`
 *        run the SAME audio-in/text-out decode as `_asr_transcribe` and
 *        additionally return per-word [start_ms, end_ms) spans. Qwen3-ASR is
 *        autoregressive (no acoustic frame alignment, and this build's
 *        flash-attention fuses the QK-softmax so cross-attention is not
 *        materialized), so the timing is the honest single-model signal:
 *        duration-proportional, character-weighted, monotonic over the cleaned
 *        transcript words, anchored on the exactly-known total audio duration
 *        (T_ms = 1000 * n_samples / sample_rate_hz). Single pipe — every
 *        platform that loads the fused lib gets word-synced transcripts.
 *        Additive symbols — a v11 caller is unaffected; a v11 library reports
 *        `asr_timestamps_supported() == 0` and the loader falls back to the
 *        text-only `_asr_transcribe`.
 *   v11: end-of-turn scoring folded in-process. `eliza_inference_llm_eot_supported()`
 *        + `_llm_eot_score` run a single causal forward pass over a tokenized
 *        partial transcript and read the next-token probability of the
 *        end-of-turn marker (e.g. <|im_end|>), replacing the retired
 *        node-llama-cpp `controlledEvaluate()` the EOT classifiers needed. The
 *        model-based EOT detector now runs through the fused lib instead of a
 *        JS-only heuristic. Additive symbols — a v10 caller is unaffected; a
 *        v10 library reports `llm_eot_supported() == 0` and the loader keeps
 *        the heuristic classifier.
 *   v10: Kokoro-82M TTS folded in-process. `eliza_inference_kokoro_supported()`
 *        + `_load` + `_synthesize` + `_sample_rate` link kokoro_lib (its own
 *        GGUF reader + iSTFT decoder) into the fused handle so the mobile
 *        Kokoro path stops POSTing to the local-TCP `llama-server
 *        /v1/audio/speech` route (forbidden on iOS / Google Play). Gated on
 *        the `ELIZA_ENABLE_KOKORO` build flag (TARGET kokoro_lib); a build
 *        without it reports `kokoro_supported() == 0` and the synth entries
 *        return ELIZA_ERR_NOT_IMPLEMENTED. Additive symbols — a v9 caller is
 *        unaffected.
 *   v9: the last text-adjacent modalities move off their separate libs into
 *       the fused handle. Three additive entrypoints + probes:
 *         - `eliza_inference_embed` + `eliza_inference_embed_supported()` —
 *           pooled text embeddings over a dedicated embedding context
 *           (`llama_set_embeddings(true)` + pooling + `llama_get_embeddings_seq`),
 *           mirroring desktop-llama-adapter.ts's `embed()`. Retires the
 *           `node-llama-cpp` embedding path: the default TEXT_EMBEDDING handler
 *           routes through the fused lib.
 *         - `eliza_inference_describe_image` +
 *           `eliza_inference_vision_supported()` — mmproj vision for the TEXT
 *           model, reusing the mtmd machinery already linked for ASR
 *           (`mtmd_helper_bitmap_init_from_buf`, `mtmd_tokenize`,
 *           `mtmd_helper_eval_chunks`). Gated on the `-DELIZA_ENABLE_VISION=1`
 *           build flag. Drops the libllama+shim mmproj vision path.
 *         - `eliza_inference_tokenize` / `eliza_inference_detokenize` +
 *           `eliza_inference_tokenize_supported()` + `eliza_inference_free_tokens`
 *           (reused) — expose `llama_tokenize` / `llama_detokenize` over the
 *           loaded text model's vocab so the desktop fused runtime stops
 *           standing up a libllama tokenizer sidecar.
 *       All v9 additions are additive symbols — a v8 caller is unaffected.
 *       The version bumps so loaders can require the new surfaces; older
 *       fused builds are still usable at degraded capability via the per-symbol
 *       `*_supported()` probes (absent symbol == unsupported).
 *   v8: streaming-LLM text path reaches feature parity with the
 *       libllama+eliza-llama-shim path. `eliza_llm_stream_config_t` grows
 *       `cache_type_k` / `cache_type_v` (KV-cache quant pass-through; names
 *       mapped to ggml_type) and `n_gpu_layers` (per-load GPU offload,
 *       replacing the ELIZA_LLM_USE_GPU env hardcode). The `_open` path now
 *       builds a same-file MTP speculative driver when `mtp_drafter_path`
 *       is set (reusing common/speculative.cpp's DRAFT_MTP engine) and
 *       `_next` drives draft+verify, populating drafter_drafted/accepted.
 *       New capability probes `eliza_inference_llm_mtp_supported()` and
 *       `eliza_inference_llm_kv_quant_supported()` let the loader refuse a
 *       library that lacks these optimizations. sizeof config = 80.
 *   v7: real Silero VAD (same symbol surface as v6).
 *   v6: fused wake-word, speaker, diarizer.
 */
#define ELIZA_INFERENCE_ABI_VERSION 18

/* Returns a static, NUL-terminated string of the form "18" matching
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
#define ELIZA_ERR_CANCELLED       -7   /* caller requested cancellation (chunk cb / cancel_tts / asr_cancel) */

/* ---- Capability probes (per capability) --------------------------- *
 *
 * Probe before binding a surface; an absent symbol (older library) means
 * unsupported. All probes are build properties and take no ctx unless noted.
 *
 *   capability              probe                                   since
 *   ----------------------  --------------------------------------  -----
 *   batch ASR + cancel      eliza_inference_asr_supported            v17
 *   ASR word timestamps     eliza_inference_asr_timestamps_supported v12
 *   streaming ASR           eliza_inference_asr_stream_supported     v2 (0 today)
 *   OmniVoice stream+cancel eliza_inference_tts_stream_supported     v2
 *   Kokoro TTS              eliza_inference_kokoro_supported         v10
 *   Kokoro G2P kind         eliza_inference_kokoro_g2p_kind(ctx)     v14
 *   Paradee TTS + misaki    eliza_inference_paradee_supported        v17
 *   misaki fallback kind    eliza_inference_paradee_g2p_kind(ctx)    v17
 *   Silero VAD              eliza_inference_vad_supported            v3/v7
 *   wake word               eliza_inference_wakeword_supported       v5
 *   speaker embedding       eliza_inference_speaker_supported        v6
 *   diarizer                eliza_inference_diariz_supported         v6
 *   streaming LLM           eliza_inference_llm_stream_supported     v4
 *   MTP / KV-cache quant    eliza_inference_llm_{mtp,kv_quant}_supported v8
 *   embeddings              eliza_inference_embed_supported          v9
 *   vision describe         eliza_inference_vision_supported         v9
 *   tokenize / detokenize   eliza_inference_tokenize_supported       v9
 *   end-of-turn scoring     eliza_inference_llm_eot_supported        v11
 */

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

/* Additive context-local text-model backend selection. Must be nonnegative;
 * zero selects CPU. Applies before the first tokenize/embed/generation load.
 * Does not change process-wide defaults or other contexts. */
EliInferenceContext * eliza_inference_create_with_options(
    const char * bundle_dir,
    int32_t n_gpu_layers,
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
 *   - "tts"  : every TTS head on the ctx. OmniVoice weights (mmap of
 *              tts/omnivoice-*.gguf), plus the Kokoro model + voice and the
 *              Paradee model + misaki lexicon once they have been loaded with
 *              `kokoro_load` / `paradee_load`.
 *   - "asr"  : ASR weights (mmap of asr/...)
 *   - "text" : text+vision weights (kept hot — always acquired)
 *   - "dflash" : drafter weights (kept hot — always acquired)
 *   - "vad" : Silero VAD weights / runtime pages
 *
 * Returns ELIZA_OK on success, negative on failure with
 * `*out_error` populated. Implementations may either issue an OS paging
 * hint (madvise MADV_DONTNEED / VirtualUnlock) or fully unload the
 * voice-only region to minimize voice-off RSS. Callers must treat an
 * evicted region as unavailable until a later `mmap_acquire(region)`.
 * The "text" and "dflash" regions are allowed to be no-ops because the
 * text runtime keeps them hot for voice-off text turns.
 *
 * Region semantics (ABI v17):
 *   evict("tts")   frees OmniVoice, Kokoro and Paradee + lexicon. Each head
 *                  is freed under its own lock, so a synth in flight on that
 *                  head finishes first. Kokoro / Paradee paths are kept.
 *   acquire("tts") reloads any Kokoro / Paradee head evicted above, then
 *                  loads OmniVoice. It succeeds without OmniVoice weights in
 *                  the bundle when a Kokoro or Paradee head is configured.
 *   Kokoro / Paradee synth calls also reload an evicted head themselves, so
 *   acquire("tts") is optional for them. OmniVoice synth still requires it.
 *   evict("asr")   frees the ASR model, context, mmproj and sampler
 *                  (unchanged); acquire("asr") reloads them.
 *   "text", "dflash", "vad": no-ops. */
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
 * (cancelling nothing is not an error).
 *
 * ABI v17: also cancels in-flight Kokoro (`kokoro_synthesize*`) and Paradee
 * (`paradee_synthesize*`) calls. Each engine has its own flag and clears it
 * when a call on that engine starts, so a cancel never carries over into a
 * call that starts after it. Paradee stops inside the graph or between
 * chunks; Kokoro is checked before and after its forward pass, so a Kokoro
 * call finishes its current pass and then returns ELIZA_ERR_CANCELLED with
 * no audio. */
int eliza_inference_cancel_tts(
    EliInferenceContext * ctx,
    char ** out_error);

/* ---- Kokoro TTS (ABI v10) ----------------------------------------- *
 *
 * Kokoro-82M TTS folded in-process so iOS / Google Play builds (which
 * forbid the local-TCP `llama-server /v1/audio/speech` route) synthesize
 * through the same dlopen()-ed libelizainference handle as OmniVoice.
 * Kokoro is a distinct TTS pipeline (phonemes -> duration/F0/style ->
 * iSTFT decoder, with its own GGUF reader) — separate from the OmniVoice
 * `eliza_inference_tts_*` path. The loaded model + voice are owned by the
 * ctx and freed in `eliza_inference_destroy`. */

/* 1 when this build linked kokoro_lib (ELIZA_ENABLE_KOKORO); 0 otherwise
 * (the synth entry points return ELIZA_ERR_NOT_IMPLEMENTED). */
int eliza_inference_kokoro_supported(void);

/* Load the Kokoro GGUF at `gguf_path` and the voice preset at
 * `voice_bin_path` (raw fp32 ref_s, `style_dim` inner dim, 256 for v1.0)
 * into `ctx`. Replaces any previously-loaded Kokoro model on the ctx.
 * Returns ELIZA_OK or a negative ELIZA_* code with `*out_error` set. */
int eliza_inference_kokoro_load(
    EliInferenceContext * ctx,
    const char * gguf_path,
    const char * voice_bin_path,
    int style_dim,
    char ** out_error);

/* Synthesize `text` through the loaded Kokoro model+voice. Writes up to
 * `max_samples` fp32 PCM samples into `out_pcm` at the model's native rate
 * (24 kHz for v1.0; query `eliza_inference_kokoro_sample_rate`). `speed`
 * scales predicted durations (1.0 = native). Returns the number of samples
 * written (>= 0), or a negative ELIZA_* code (ELIZA_ERR_INVALID_ARG with the
 * required size in `*out_error` when the buffer is too small). */
int eliza_inference_kokoro_synthesize(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    float speed,
    float * out_pcm,
    size_t max_samples,
    char ** out_error);

/* The loaded Kokoro model's audio sample rate (24000 for v1.0), or a
 * negative ELIZA_* code if no Kokoro model is loaded. */
int eliza_inference_kokoro_sample_rate(EliInferenceContext * ctx);

/* ---- Kokoro G2P kind + IPA synthesis (ABI v14) -------------------- *
 *
 * Which grapheme->phoneme path the linked kokoro_lib uses, so the TS voice
 * layer can decide whether it must pre-phonemize:
 *   ELIZA_KOKORO_G2P_ESPEAK (1): the lib links libespeak-ng and phonemizes raw
 *       text correctly inside `eliza_inference_kokoro_synthesize` — pass text.
 *   ELIZA_KOKORO_G2P_ASCII (0): the lib has NO espeak; the text path uses the
 *       lossy per-byte ASCII grapheme fallback (unintelligible). The caller MUST
 *       run its own espeak-ng G2P and call
 *       `eliza_inference_kokoro_synthesize_ipa` with the IPA instead.
 * This is a build property (independent of any loaded model); `ctx` is accepted
 * for API symmetry. Returns a negative ELIZA_* code on a non-Kokoro build. */
#define ELIZA_KOKORO_G2P_ASCII  0
#define ELIZA_KOKORO_G2P_ESPEAK 1
int eliza_inference_kokoro_g2p_kind(EliInferenceContext * ctx);

/* Synthesize from precomputed espeak-ng IPA (UTF-8) instead of raw text: the
 * IPA is mapped straight to Kokoro vocab ids (`ipa_to_token_ids`), bypassing the
 * in-lib phonemizer. This is the intelligible path on espeak-less builds
 * (Android / iOS / host-without-libespeak) — the TS layer runs the espeak-ng
 * WASM phonemizer and passes the IPA here. Same return contract as
 * `eliza_inference_kokoro_synthesize`. */
int eliza_inference_kokoro_synthesize_ipa(
    EliInferenceContext * ctx,
    const char * ipa,
    size_t ipa_len,
    float speed,
    float * out_pcm,
    size_t max_samples,
    char ** out_error);

/* ---- Exact-size Kokoro PCM ownership (ABI v15) ------------------- *
 *
 * These entries run the same raw-text / IPA synthesis as the caller-buffer
 * forms above, then transfer an exact-size malloc-owned PCM buffer to the
 * caller. On success `*out_pcm` is NULL only when `*out_samples == 0`.
 * Release every non-NULL result with `eliza_inference_free_pcm`.
 *
 * The allocation is owned by the library so callers do not guess an utterance
 * duration, truncate valid audio, or repeat an expensive model forward merely
 * to learn the required sample count. */
int eliza_inference_kokoro_synthesize_alloc(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    float speed,
    float ** out_pcm,
    size_t * out_samples,
    char ** out_error);

int eliza_inference_kokoro_synthesize_ipa_alloc(
    EliInferenceContext * ctx,
    const char * ipa,
    size_t ipa_len,
    float speed,
    float ** out_pcm,
    size_t * out_samples,
    char ** out_error);

void eliza_inference_free_pcm(float * pcm);

/* ---- Paradee-8M TTS + native misaki G2P (ABI v17) ----------------- *
 *
 * Paradee-8M v1.0 (Apache-2.0, distilled from Kokoro-82M): one voice
 * (af_heart), 24 kHz mono fp32 out. The model input is misaki phoneme ids
 * (the Kokoro vocab) with a 0 pad at each end, at most 512 ids, plus a speed
 * scalar. G2P runs natively through the misaki English lexicon + fallback
 * linked into this library; no ONNX, no host phonemizer.
 *
 * Build flag `ELIZA_ENABLE_PARADEE` (TARGETs paradee_lib + misaki_g2p). In a
 * build without it `paradee_supported() == 0` and every other entry returns
 * ELIZA_ERR_NOT_IMPLEMENTED. Model + lexicon are owned by the ctx, guarded by
 * their own lock (independent of OmniVoice / Kokoro), freed by
 * `mmap_evict("tts")` (reloaded lazily) and by `eliza_inference_destroy`.
 * `eliza_inference_cancel_tts` cancels an in-flight Paradee synth. */

/* 1 when this build linked paradee_lib + misaki_g2p; 0 otherwise. */
int eliza_inference_paradee_supported(void);

/* Load the Paradee GGUF and the misaki lexicon into `ctx`. A repeat call with
 * the same paths is a no-op. `espeak_data_dir` may be NULL: the lexicon then
 * uses its rules fallback for out-of-vocabulary words (see `g2p_kind`).
 * On failure the previously loaded model, if any, stays loaded. Returns
 * ELIZA_OK or a negative ELIZA_* code with `*out_error` set. */
int eliza_inference_paradee_load(
    EliInferenceContext * ctx,
    const char * gguf_path,
    const char * lexicon_path,
    const char * espeak_data_dir,
    char ** out_error);

/* Sample rate of the loaded model (24000 for v1.0). Still answers after
 * `mmap_evict("tts")`. Negative ELIZA_* if `paradee_load` never succeeded. */
int eliza_inference_paradee_sample_rate(EliInferenceContext * ctx);

/* How the loaded misaki lexicon phonemizes words it does not contain. */
#define ELIZA_PARADEE_G2P_LEXICON_ONLY 0  /* no fallback */
#define ELIZA_PARADEE_G2P_RULES        1  /* native letter-to-sound rules */
#define ELIZA_PARADEE_G2P_ESPEAK       2  /* eSpeak NG, converted to misaki spelling */
/* Returns one of ELIZA_PARADEE_G2P_*, or a negative ELIZA_* code when no
 * lexicon was loaded (or on a non-Paradee build). */
int eliza_inference_paradee_g2p_kind(EliInferenceContext * ctx);

/* Run the native G2P only: UTF-8 English text in, misaki phoneme string out.
 * On success `*out_utf8` is a NUL-terminated heap string (free it with
 * `eliza_inference_free_string`) and the return value is its byte length. */
int eliza_inference_paradee_phonemize(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    char ** out_utf8,
    char ** out_error);

/* Text -> PCM. Native misaki G2P, then the phoneme string is split into
 * <= 510-id chunks (sentence ends, then clause punctuation, then spaces),
 * each chunk is padded and synthesized, and the PCM is concatenated. `speed`
 * scales the speaking rate (1.0 = native; <= 0 or non-finite means 1.0;
 * other values are clamped to [0.25, 4]).
 * On success `*out_pcm` is a malloc-owned buffer of `*out_samples` floats at
 * `paradee_sample_rate` (NULL only when `*out_samples == 0`); release it with
 * `eliza_inference_free_pcm`. Returns ELIZA_OK, ELIZA_ERR_CANCELLED after
 * `eliza_inference_cancel_tts`, or another negative ELIZA_* code. */
int eliza_inference_paradee_synthesize_alloc(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    float speed,
    float ** out_pcm,
    size_t * out_samples,
    char ** out_error);

/* Same as `paradee_synthesize_alloc`, but the input is a misaki phoneme
 * string (as returned by `paradee_phonemize`); G2P is skipped. Characters
 * outside the model vocab are dropped. */
int eliza_inference_paradee_synthesize_phonemes_alloc(
    EliInferenceContext * ctx,
    const char * misaki_phonemes,
    size_t phonemes_len,
    float speed,
    float ** out_pcm,
    size_t * out_samples,
    char ** out_error);

/* ---- OmniVoice reference encode (ABI v4) -------------------------- *
 *
 * Encode a 24 kHz mono fp32 PCM buffer through the OmniVoice tokenizer
 * (HuBERT semantic encoder + RVQ codec) and return the resulting
 * reference-audio-token tensor `[K=8, ref_T]` as int32 row-major.
 *
 * This is the encode-only half of the TTS pipeline that the freeze CLI
 * (`packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs`) uses to
 * persist a samantha-locked preset under
 * `<bundle_dir>/cache/voice-preset-samantha.bin`. At runtime the
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

/* ---- Native VAD (ABI v3 symbols, real backend at ABI v7) ---------- *
 *
 * Native Silero v5 VAD backend. The shape intentionally mirrors
 * `voice/vad.ts::SileroVad`: 16 kHz mono fp32 PCM, 512-sample windows,
 * one probability in [0, 1] per call, and recurrent (LSTM) state reset
 * at utterance boundaries. The fused build resolves the Silero GGUF from
 * `<bundle_dir>/vad/` (conventionally `silero-vad-v5.gguf`) and runs the
 * vendored scalar-C forward graph under
 * `tools/omnivoice/src/voice-classifiers/vad/`. The JS binding chooses
 * this backend when `eliza_inference_vad_supported() == 1`; otherwise it
 * falls back to the standalone Silero VAD path unchanged.
 *
 * These five symbols were declared in ABI v3 but stubbed
 * (`vad_supported() == 0`) until ABI v7 wired the real backend; the
 * declarations are unchanged so a v3..v6 caller binds them as-is.
 */

/* Capability probe: 1 when this build implements native VAD (ABI v7+),
 * 0 when it does not (older stub / VAD-disabled build). */
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

/* ---- Native wake-word (ABI v5) ------------------------------------ *
 *
 * Native openWakeWord backend. The shape mirrors
 * `voice/wake-word.ts::GgmlWakeWordModel`: 16 kHz mono fp32 PCM,
 * 1280-sample (80 ms) frames, one P(wake) in [0, 1] per call, streaming
 * state reset at utterance boundaries. The fused build resolves the
 * three head GGUFs
 * (`<bundle_dir>/wake/<head>.{melspec,embedding,classifier}.gguf`)
 * from the context bundle + the head name passed at open, then runs the
 * vendored scalar-C three-stage pipeline (melspec → embedding →
 * classifier). The JS binding routes wake-word detection exclusively
 * through this surface when `eliza_inference_wakeword_supported() == 1`;
 * otherwise the wake-word path throws (no ONNX fallback). */

/* Capability probe: 1 when this build implements native wake-word, 0
 * when it does not (stub / wake-word-disabled build). */
int eliza_inference_wakeword_supported(void);

/* Opaque native wake-word session. One per detector. */
typedef struct EliWakeWord EliWakeWord;

/* Open a wake-word session anchored to `ctx`. `sample_rate_hz` must be
 * 16000. `head_name` selects the wake phrase (e.g. "hey-eliza") and is
 * used to resolve `<bundle_dir>/wake/<head_name>.{melspec,embedding,
 * classifier}.gguf`. Returns NULL on failure with `*out_error`
 * populated. */
EliWakeWord * eliza_inference_wakeword_open(
    EliInferenceContext * ctx,
    int sample_rate_hz,
    const char * head_name,
    char ** out_error);

/* Score one 1280-sample (80 ms @ 16 kHz) fp32 mono frame and write the
 * latest P(wake) in [0, 1] into `*out_probability`. Early calls before
 * enough context accumulates write 0. Returns ELIZA_OK on success or a
 * negative ELIZA_* code on failure. */
int eliza_inference_wakeword_score(
    EliWakeWord * wake,
    const float * pcm,
    size_t n_samples,
    float * out_probability,
    char ** out_error);

/* Clear all streaming state (audio tail, mel ring, embedding ring) at
 * utterance boundaries. Returns ELIZA_OK on success. */
int eliza_inference_wakeword_reset(
    EliWakeWord * wake,
    char ** out_error);

/* Close + free a native wake-word session. Idempotent on NULL. */
void eliza_inference_wakeword_close(EliWakeWord * wake);

/* ---- Native speaker encoder (ABI v6) ------------------------------ *
 *
 * Native WeSpeaker ResNet34-LM speaker-embedding encoder. The shape
 * mirrors `voice/speaker/encoder.ts`: 16 kHz mono fp32 PCM in, one
 * L2-normalized 256-d speaker embedding out, for cosine-distance
 * matching. The fused build resolves the encoder GGUF from
 * the `<bundle_dir>/speaker/` dir (or accepts an explicit path) and runs
 * the vendored scalar-C forward graph. */

/* Capability probe: 1 when this build implements the native speaker
 * encoder, 0 otherwise. */
int eliza_inference_speaker_supported(void);

/* Opaque native speaker-encoder session. One per encoder. */
typedef struct EliSpeaker EliSpeaker;

/* Open a speaker-encoder session anchored to `ctx`. `gguf_path` may be
 * NULL to resolve the `<bundle_dir>/speaker/` dir, or a non-empty
 * absolute path to a WeSpeaker GGUF. Returns NULL on failure with
 * `*out_error` populated. */
EliSpeaker * eliza_inference_speaker_open(
    EliInferenceContext * ctx,
    const char * gguf_path,
    char ** out_error);

/* Embed `n_samples` of 16 kHz mono fp32 PCM into a 256-d L2-normalized
 * speaker embedding written to `out_embedding` (caller-owned, must hold
 * at least 256 floats). Returns ELIZA_OK on success or a negative
 * ELIZA_* code on failure. */
int eliza_inference_speaker_embed(
    EliSpeaker * speaker,
    const float * pcm,
    size_t n_samples,
    float * out_embedding,
    char ** out_error);

/* Reserved free hook to mirror the encode/free pair in the JS binding.
 * The embedding buffer is caller-owned in `_embed`, so this is a no-op
 * provided for ABI symmetry. Safe on NULL. */
void eliza_inference_speaker_free(float * embedding);

/* Close + free a native speaker-encoder session. Idempotent on NULL. */
void eliza_inference_speaker_close(EliSpeaker * speaker);

/* ---- Native diarizer (ABI v6) ------------------------------------- *
 *
 * Native pyannote-segmentation-3.0 diarizer. The shape mirrors
 * `voice/speaker/diarizer.ts`: a fixed 80000-sample (5 s) 16 kHz mono
 * fp32 window in, a per-frame powerset-label sequence out (293 int8
 * labels, one per frame, each in [0, 7) over the pyannote powerset
 * classes). The fused build resolves the diarizer GGUF from
 * the `<bundle_dir>/diariz/` dir (or accepts an explicit path) and runs
 * the vendored scalar-C forward graph; agglomerative clustering across
 * windows stays JS-side. */

/* Capability probe: 1 when this build implements the native diarizer, 0
 * otherwise. */
int eliza_inference_diariz_supported(void);

/* Opaque native diarizer session. One per diarizer. */
typedef struct EliDiariz EliDiariz;

/* Open a diarizer session anchored to `ctx`. `gguf_path` may be NULL to
 * resolve the `<bundle_dir>/diariz/` dir, or a non-empty absolute path to
 * a pyannote GGUF. Returns NULL on failure with `*out_error`
 * populated. */
EliDiariz * eliza_inference_diariz_open(
    EliInferenceContext * ctx,
    const char * gguf_path,
    char ** out_error);

/* Segment `n_samples` of 16 kHz mono fp32 PCM (must be the 80000-sample
 * window) into a per-frame powerset-label sequence. The caller passes
 * the capacity of `out_labels` in `*io_n_labels`; on success the
 * function writes `frames_per_window` (293) int8 labels and sets
 * `*io_n_labels` to that count. On `ELIZA_ERR_INVALID_ARG` for a too-
 * small buffer it sets `*io_n_labels` to the required count without
 * writing. Returns ELIZA_OK on success or a negative ELIZA_* code. */
int eliza_inference_diariz_segment(
    EliDiariz * diariz,
    const float * pcm,
    size_t n_samples,
    int8_t * out_labels,
    size_t * io_n_labels,
    char ** out_error);

/* Close + free a native diarizer session. Idempotent on NULL. */
void eliza_inference_diariz_close(EliDiariz * diariz);

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

/* ---- ASR probe + cancel (ABI v17) --------------------------------- */

/* 1 when this build has the batch ASR path (mtmd audio encoder compiled in).
 * Always 1 for libelizainference, which is only built with mtmd. Whether the
 * bundle has ASR weights is answered by `mmap_acquire("asr")`. */
int eliza_inference_asr_supported(void);

/* Cancel the `asr_transcribe` / `asr_transcribe_timed` call in flight on
 * `ctx` (from another thread). Sets an atomic flag without taking the ASR
 * lock. The flag is checked by the llama abort callback during the prefill
 * and decode graphs, between prompt chunks, and before every decode token;
 * the audio encoder pass itself has no abort hook, so a cancel during it
 * lands when that pass ends. The cancelled call returns ELIZA_ERR_CANCELLED.
 * Each transcription clears the flag when it starts (after it holds the ASR
 * lock), so a cancel with nothing in flight has no effect on later calls.
 * Returns ELIZA_OK (cancelling nothing is not an error), or
 * ELIZA_ERR_INVALID_ARG for a NULL ctx. */
int eliza_inference_asr_cancel(
    EliInferenceContext * ctx,
    char ** out_error);

/* ---- ASR word timestamps (ABI v12) -------------------------------- */

/* Capability probe: returns 1 when this build can emit per-word timestamps
 * from `eliza_inference_asr_transcribe_timed`, 0 otherwise. A v11 library
 * lacks the symbol entirely (loader treats absent == unsupported). */
int eliza_inference_asr_timestamps_supported(void);

/* Transcribe like `eliza_inference_asr_transcribe` AND return per-word timing.
 * `out_text` receives the same UTF-8 NUL-terminated transcript. The caller
 * provides `out_word_start_ms` / `out_word_end_ms` as int arrays each of
 * capacity `*io_n_words`; the library writes one [start_ms, end_ms) pair per
 * whitespace-delimited word of the transcript (in order), and updates
 * `*io_n_words` to the count actually written. The word boundaries match a
 * plain whitespace split of `out_text`, so the caller zips the two. Timing is
 * duration-proportional + character-weighted + monotonic over the words,
 * anchored on the exact input duration (see the v12 changelog).
 *
 * Returns the number of transcript bytes written (excluding the terminator)
 * on success, or a negative ELIZA_* code on failure. */
int eliza_inference_asr_transcribe_timed(
    EliInferenceContext * ctx,
    const float * pcm,
    size_t n_samples,
    int sample_rate_hz,
    char * out_text,
    size_t max_text_bytes,
    int * out_word_start_ms,
    int * out_word_end_ms,
    size_t * io_n_words,
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

/* ---- Streaming LLM (ABI v4, additive) ----------------------------- *
 *
 * In-process text generation. Replaces the legacy "spawn llama-server as a
 * child process and stream over loopback HTTP" path: the stock Android /
 * iOS sandboxes forbid forking executables out of the app private dir, and
 * the per-token HTTP round-trip dwarfs the latency speculative decoding is
 * meant to save. The session loads its own text GGUF (resolved from the
 * bundle's `text/` directory) into a private llama_context + sampler chain
 * and decodes against it.
 *
 * The surface is PULL-based and token-id oriented to match the Bun loader
 * in `plugin-local-inference/src/services/voice/ffi-bindings.ts`:
 *   open → prefill → next* → close
 * `_next` returns 0 (more output available), 1 (final step — EOS / cap), or
 * a negative ELIZA_* code. The JS runner does NOT register a per-token
 * callback; it polls `_next` and reads the committed-token batch out of the
 * caller-provided buffers. `_cancel` flips an atomic the decode loop checks
 * at each step boundary so an in-flight `_next` returns ELIZA_ERR_CANCELLED.
 *
 * Symbols are exported behind `eliza_inference_llm_stream_supported()`; a
 * build that does not wire real forward passes returns 0 there and the
 * loader picks the legacy HTTP path (desktop only — mobile requires this).
 */

/* 1 only when this build wires real streaming-LLM forward passes + the
 * cooperative cancel path; 0 otherwise. */
int eliza_inference_llm_stream_supported(void);

/* ---- Streaming-LLM capability probes (ABI v8) --------------------- *
 *
 * These let the TS loader REFUSE the fused text path on a library that
 * does not actually wire the make-or-break text optimizations, instead of
 * silently regressing to a plain fixed-KV non-speculative loop. A build
 * that wires same-file MTP speculative decoding returns 1 from
 * `_mtp_supported`; a build that maps + applies KV-cache quant types
 * returns 1 from `_kv_quant_supported`. Older v7 libraries do not export
 * these symbols at all, so absence == unsupported. */
int eliza_inference_llm_mtp_supported(void);
int eliza_inference_llm_kv_quant_supported(void);

/* Per-session config. Mirrored 1:1 by `LlmStreamConfig` marshalling in
 * `ffi-bindings.ts` (8-byte aligned, sizeof = 80). `slot_id` may be -1 to
 * disable slot pinning. `prompt_cache_key` / `mtp_drafter_path` /
 * `gbnf_grammar` / `cache_type_k` / `cache_type_v` may be NULL. When
 * `gbnf_grammar` is a non-empty GBNF source string the session installs a
 * grammar sampler FIRST in the chain so every sampled token is
 * grammar-constrained — this is how the structured-reply envelope is forced
 * on the in-process FFI path. `disable_thinking` is a v1 no-op passthrough.
 *
 * `mtp_drafter_path` (ABI v8): absolute path of a same-file MTP drafter
 * GGUF. When set (and `draft_min`/`draft_max` are > 0) `_open` builds a
 * same-file MTP speculative driver against the SAME model (a second
 * LLAMA_CONTEXT_TYPE_MTP context) and `_next` drives draft+verify, exactly
 * mirroring desktop-llama-adapter.ts's same-file MTP path. NULL disables
 * speculative decoding.
 *
 * `n_gpu_layers` (ABI v8): number of model layers to offload to GPU at load.
 * -1 selects the runtime default (all layers / 99); 0 forces CPU. Replaces
 * the ELIZA_LLM_USE_GPU env hardcode.
 *
 * `cache_type_k` / `cache_type_v` (ABI v8): KV-cache quantization type names
 * (e.g. "f16", "q8_0", "qjl1_256", "q4_polar"). NULL leaves the llama.cpp
 * default (f16). Mapped to ggml_type and applied to cparams.type_k/type_v.
 * Mirrors desktop-llama-adapter.ts's GGML_KV_CACHE_TYPES pass-through.
 *
 * `context_size` (ABI v9): runtime context window in tokens. <=0 falls back
 * to ELIZA_LLM_N_CTX or the native default. */
typedef struct {
    int32_t      max_tokens;
    float        temperature;
    float        top_p;
    int32_t      top_k;
    float        repeat_penalty;
    int32_t      slot_id;
    const char * prompt_cache_key;   /* NULL ok */
    int32_t      draft_min;
    int32_t      draft_max;
    const char * mtp_drafter_path;   /* NULL disables speculative */
    const char * gbnf_grammar;       /* NULL/empty = no grammar constraint */
    int32_t      disable_thinking;   /* 0/1 — v1 no-op */
    int32_t      n_gpu_layers;       /* -1 = default (all), 0 = CPU (ABI v8) */
    const char * cache_type_k;       /* KV K-cache quant name; NULL = f16 (ABI v8) */
    const char * cache_type_v;       /* KV V-cache quant name; NULL = f16 (ABI v8) */
    int32_t      context_size;       /* Runtime context tokens; <=0 = env/default (ABI v9) */
} eliza_llm_stream_config_t;

/* Opaque streaming-LLM session. One per active generation. */
typedef struct EliLlmStream EliLlmStream;

/* Resolve the streaming context capacity against the resident text model
 * before token admission (ABI v18). Loads the model with n_gpu_layers when
 * necessary. requested_context <=0 uses ELIZA_LLM_N_CTX or 8192; the result
 * is clamped to the GGUF training context exactly as stream_open does.
 * On success, pass *out_capacity explicitly to stream_open to preserve this
 * decision even if the environment changes. No decode context is allocated. */
int eliza_inference_llm_context_capacity(
    EliInferenceContext * ctx,
    int32_t requested_context,
    int32_t n_gpu_layers,
    int32_t * out_capacity,
    char ** out_error);

/* Open a session anchored to `ctx`. Loads the bundle's text GGUF on first
 * open and reuses it across sessions. Returns NULL on failure with
 * `*out_error` populated. Close exactly once via `_close`. */
EliLlmStream * eliza_inference_llm_stream_open(
    EliInferenceContext * ctx,
    const eliza_llm_stream_config_t * cfg,
    char ** out_error);

/* Feed pre-tokenized prompt tokens into the session KV before the first
 * `_next`. `token_ids` is `num_tokens` int32s the library copies. Returns
 * ELIZA_OK on success or a negative ELIZA_* code. */
int eliza_inference_llm_stream_prefill(
    EliLlmStream * stream,
    const int32_t * token_ids,
    size_t num_tokens,
    char ** out_error);

/* Pull the next step. Samples up to `tokens_cap` tokens (bounded internally
 * by the per-step cap), writes the committed token ids into `tokens_out`
 * (count into `*num_tokens_out`) and the detokenized UTF-8 into `text_out`
 * (NUL-terminated, up to `text_cap`). `drafter_drafted_out` /
 * `drafter_accepted_out` carry the per-step MTP stats (drafted + accepted
 * draft tokens this step; 0 when no MTP drafter is attached). Returns 0
 * (more), 1 (final step), or a negative ELIZA_* code (ELIZA_ERR_CANCELLED
 * on cancel). */
int eliza_inference_llm_stream_next(
    EliLlmStream * stream,
    int32_t * tokens_out,
    size_t tokens_cap,
    size_t * num_tokens_out,
    char * text_out,
    size_t text_cap,
    int32_t * drafter_drafted_out,
    int32_t * drafter_accepted_out,
    char ** out_error);

/* Hard-cancel an in-flight `_next` (publishes an atomic flag; safe from
 * another thread). Returns ELIZA_OK whether or not a pass was running. */
int eliza_inference_llm_stream_cancel(EliLlmStream * stream);

/* Slot KV persistence — optional. v1 returns ELIZA_ERR_INVALID_ARG. */
int eliza_inference_llm_stream_save_slot(
    EliLlmStream * stream,
    const char * filename,
    char ** out_error);

int eliza_inference_llm_stream_restore_slot(
    EliLlmStream * stream,
    const char * filename,
    char ** out_error);

/* Reset a streaming-LLM session for reuse: clears the KV cache, resets the
 * sampler + counters so the next prefill starts a fresh prompt on the SAME
 * llama_context. Lets a caller keep one warm context alive across turns instead
 * of open/close per turn (faster, and avoids the shared-GPU-weights lctx-churn
 * corruption). Resets MTP streams too: clears both the target and draft KV
 * caches + drops the speculative accumulator so the next prefill re-arms
 * cleanly. Returns ELIZA_ERR_INVALID_ARG only when the stream is NULL/unopened. */
int eliza_inference_llm_stream_reset(EliLlmStream * stream);

/* Prefix-preserving reset: KEEP the first n_keep tokens of KV cache resident and
 * drop everything after, so the next prefill only decodes the per-turn delta (the
 * system + tool-schema prefix is identical turn-to-turn and dominates per-turn
 * latency on Mali's scalar-matmul prefill). The next prefill then appends at
 * position n_keep. Non-MTP streams only (MTP would need its speculative draft
 * head re-seeded for the skipped prefix). Returns the n_keep actually applied
 * (>= 0; may be clamped to n_past or 0 on a partial-trim fallback), or a negative
 * ELIZA_* on a NULL/MTP/unopened stream. */
int eliza_inference_llm_stream_reset_keep(EliLlmStream * stream, int32_t n_keep);

/* Close + free a streaming-LLM session. Idempotent on NULL. */
void eliza_inference_llm_stream_close(EliLlmStream * stream);

/* ---- Text embeddings (ABI v9, additive) --------------------------- *
 *
 * Pooled sentence embeddings over the bundle's text GGUF. This is what lets
 * the default TEXT_EMBEDDING handler drop `node-llama-cpp`: the fused lib
 * loads the text model once into a DEDICATED embedding context
 * (`llama_set_embeddings(true)` + a non-causal single-ubatch layout sized to
 * the context + a pooling type), decodes the tokenized text, and reads the
 * pooled `llama_get_embeddings_seq` vector back. Mirrors
 * desktop-llama-adapter.ts's `embed()` exactly.
 *
 * The embedding context is separate from the streaming-LLM generation
 * context (embeddings require non-causal attention + pooling, generation
 * requires causal). It is lazily created on the first `_embed` call against
 * `ctx` and reused, anchored on the SAME shared text model the streaming-LLM
 * path loads. Each call clears the embedding KV first so embeddings are
 * independent (single-sequence, seq_id 0).
 */

/* Pooling strategy. Mirrors `enum llama_pooling_type`:
 *   0 = NONE (no pooling — invalid for `_embed`, which needs a pooled vector)
 *   1 = MEAN (the gte-small / BERT bi-encoder default)
 *   2 = CLS
 *   3 = LAST (the `--pooling last` decoder-as-embedder convention) */
#define ELIZA_POOLING_NONE 0
#define ELIZA_POOLING_MEAN 1
#define ELIZA_POOLING_CLS  2
#define ELIZA_POOLING_LAST 3

/* Capability probe: 1 when this build wires the real embedding path (always
 * 1 for a v9 build with the text model loadable). A v8 library does not
 * export this symbol, so absence == unsupported and the loader keeps the
 * node-llama-cpp / libllama embedding path. */
int eliza_inference_embed_supported(void);

/* Compute a pooled sentence embedding for `text` (UTF-8, `text_len` bytes,
 * NUL not required). `pooling` selects the pooling strategy (see
 * ELIZA_POOLING_*); pass ELIZA_POOLING_MEAN for the gte-small convention or
 * ELIZA_POOLING_LAST for a decoder-as-embedder.
 *
 * On success writes up to `out_capacity` fp32 values into `out_embedding`,
 * sets `*out_dim` to the model's `n_embd` (the real dimension), and returns
 * ELIZA_OK. The embedding is L2-normalized (the gte-small convention) before
 * it is written. If `out_capacity < n_embd` the library writes nothing,
 * sets `*out_dim = n_embd`, and returns ELIZA_ERR_INVALID_ARG with a
 * diagnostic in `*out_error` so the caller can resize and retry.
 *
 * The text region need not be acquired — embeddings use the text model the
 * streaming-LLM path loads, resolved from `<bundle>/text/`. The first call
 * loads it if it is not resident yet. Returns a negative ELIZA_* code on
 * failure with `*out_error` populated. */
int eliza_inference_embed(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    int pooling,
    float * out_embedding,
    size_t out_capacity,
    int * out_dim,
    char ** out_error);

/* Additive embedding entrypoint with explicit added-token handling.
 * parse_special is 0 (literal input) or 1 (recognize vocabulary special tokens).
 * Canonical BGE callers use 1 for both admission and inference. This entrypoint
 * rejects inputs beyond the encoder context instead of encoding a prefix.
 * The existing eliza_inference_embed ABI and its defaults remain available. */
int eliza_inference_embed_with_options(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    int pooling,
    int parse_special,
    float * out_embedding,
    size_t out_capacity,
    int * out_dim,
    char ** out_error);

/* ---- End-of-turn scoring (ABI v11, additive) --------------------- *
 *
 * Score whether the user has finished their turn by reading the next-token
 * probability of the chat template's end-of-turn marker (e.g. <|im_end|>)
 * after a partial ASR transcript. This is the fused replacement for the
 * retired node-llama-cpp `controlledEvaluate()` path the EOT classifiers used:
 * the JS side formats the partial transcript as a user turn, tokenizes it via
 * `eliza_inference_tokenize`, looks up the end-of-turn token id, and reads back
 * P(end-of-turn). Runs on a dedicated CAUSAL context over the resident text
 * model (logits at the final position), lazily created and reused, KV cleared
 * per call so each score is independent. A v10 library does not export these
 * symbols, so absence == unsupported and the loader keeps the heuristic EOT
 * classifier.
 */

/* Capability probe: 1 when this build wires the real EOT scoring path. */
int eliza_inference_llm_eot_supported(void);

/* Single causal forward pass over `token_ids` (`num_tokens` int32s the library
 * copies). Writes the next-token softmax probability of `target_token_id` into
 * `*out_target_prob`. Optionally also writes the argmax next-token id into
 * `*out_top_token` and its probability into `*out_top_prob` (pass NULL to skip
 * either). The context is truncated to its scoring window from the TAIL when it
 * overflows. Returns ELIZA_OK or a negative ELIZA_* code with `*out_error`
 * populated. */
int eliza_inference_llm_eot_score(
    EliInferenceContext * ctx,
    const int32_t * token_ids,
    size_t num_tokens,
    int32_t target_token_id,
    float * out_target_prob,
    int32_t * out_top_token,
    float * out_top_prob,
    char ** out_error);

/* ---- mmproj vision describe (ABI v9, additive) -------------------- *
 *
 * Describe an image with the TEXT model + its mmproj projector, reusing the
 * mtmd machinery already linked + initialized for ASR
 * (`mtmd_init_from_file`, `mtmd_helper_bitmap_init_from_buf`,
 * `mtmd_tokenize`, `mtmd_helper_eval_chunks`). Mirrors
 * desktop-llama-adapter.ts's `describeImage()`. This drops the
 * libllama+eliza-llama-shim mmproj vision path: the IMAGE_DESCRIPTION handler
 * prefers this entry when `eliza_inference_vision_supported() == 1`.
 *
 * Gated on the `-DELIZA_ENABLE_VISION=1` build flag (same flag the shim path
 * uses). A build without it returns 0 from `_vision_supported()` and
 * ELIZA_ERR_NOT_IMPLEMENTED from `_describe_image`, so the caller falls back
 * to the libllama mtmd path.
 */

/* Capability probe: 1 when this build was compiled with ELIZA_ENABLE_VISION
 * and can describe an image through mmproj; 0 otherwise (the IMAGE_DESCRIPTION
 * handler then routes through the libllama mtmd path). */
int eliza_inference_vision_supported(void);

/* Describe `image_bytes` (a raw PNG/JPEG/WebP buffer of `n_bytes`) using the
 * loaded text model and the mmproj projector at `mmproj_path`. `prompt` may
 * be NULL (a default "Describe what is in this image." is used). The library
 * writes a UTF-8 NUL-terminated description into `out_text` (up to
 * `max_text_bytes - 1` bytes + terminator).
 *
 * The text model is loaded on first use (same resident model the
 * streaming-LLM / embedding paths share); the mmproj context is loaded on
 * first use per `mmproj_path` and reused. Returns the number of bytes written
 * (excluding the terminator) on success, ELIZA_ERR_NOT_IMPLEMENTED when the
 * build lacks vision, or another negative ELIZA_* code on failure with
 * `*out_error` populated. */
int eliza_inference_describe_image(
    EliInferenceContext * ctx,
    const unsigned char * image_bytes,
    size_t n_bytes,
    const char * mmproj_path,
    const char * prompt,
    char * out_text,
    size_t max_text_bytes,
    char ** out_error);

/* ---- Tokenizer (ABI v9, additive) --------------------------------- *
 *
 * Expose `llama_tokenize` / `llama_detokenize` over the loaded text model's
 * vocab so the desktop fused runtime can stop standing up a libllama
 * tokenizer sidecar (`desktop-fused-ffi-backend-runtime.ts`'s "tokenization
 * seam"). The vocab is the SAME shared text model the streaming-LLM path
 * loads, so the tokenizer matches the generation model exactly with no second
 * weight load.
 */

/* Capability probe: 1 when this build exposes the tokenizer over the loaded
 * text vocab. A v8 library does not export this symbol, so absence ==
 * unsupported and the desktop fused runtime keeps the libllama sidecar. */
int eliza_inference_tokenize_supported(void);

/* Tokenize `text` (UTF-8, `text_len` bytes) against the loaded text model's
 * vocab. `add_special` adds the model's BOS/EOS markers; `parse_special`
 * renders special tokens from the input text. On success the library
 * malloc-allocates an int32 token-id array, writes its pointer into
 * `*out_tokens` and the count into `*out_n`, and returns ELIZA_OK. The caller
 * MUST release the buffer via `eliza_inference_free_tokens`. A NULL
 * `out_tokens` / `out_n` is a programmer error. Returns a negative ELIZA_*
 * code on failure with `*out_error` populated.
 *
 * The first call loads the text model from `<bundle>/text/` if it is not
 * resident yet (shared with the streaming-LLM / embedding paths). */
int eliza_inference_tokenize(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    int add_special,
    int parse_special,
    int ** out_tokens,
    size_t * out_n,
    char ** out_error);

/* Detokenize `n_tokens` token ids back to UTF-8 text against the loaded text
 * model's vocab. Writes a NUL-terminated string into `out_text` (up to
 * `max_text_bytes - 1` bytes + terminator). `remove_special` strips BOS/EOS;
 * `unparse_special` renders special tokens. Returns the number of bytes
 * written (excluding the terminator) on success, or a negative ELIZA_* code
 * on failure with `*out_error` populated. */
int eliza_inference_detokenize(
    EliInferenceContext * ctx,
    const int * tokens,
    size_t n_tokens,
    int remove_special,
    int unparse_special,
    char * out_text,
    size_t max_text_bytes,
    char ** out_error);

/* ---- Memory ownership helpers -------------------------------------- */

/* Free a string the library allocated and handed out (error messages,
 * future transcript buffers). Safe on NULL. */
void eliza_inference_free_string(char * str);

#ifdef __cplusplus
}
#endif

#endif /* ELIZA_INFERENCE_FFI_H */
