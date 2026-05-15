/*
 * voice-classifier-cpp — public C ABI for the standalone native plugin
 * that ports three small voice-side classifiers to the elizaOS/llama.cpp
 * fork's ggml dispatcher, replacing onnxruntime-node:
 *
 *   1. Voice emotion classifier — returns soft probabilities over a
 *      fixed 7-class basic-emotion set (neutral, happy, sad, angry,
 *      fear, disgust, surprise). Suggested upstreams to convert: an
 *      ECAPA / wav2vec2-based emotion head such as
 *      `harshit345/xlsr-wav2vec-speech-emotion-recognition` (CC-BY-NC) or
 *      `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` (with
 *      teacher distillation to a small student); the GGUF schema is
 *      pinned at conversion time.
 *
 *   2. End-of-turn (EOT) detector — binary turn-completion classifier
 *      operating on a short audio window (NOT on text). Suggested
 *      upstreams: `livekit/turn-detector` audio variants or
 *      `pipecat-ai/turn`. Output is a single P(end_of_turn) ∈ [0, 1].
 *
 *   3. Speaker embedding encoder — emits a 192-dim ECAPA-TDNN /
 *      x-vector style speaker embedding suitable for cosine-distance
 *      matching. Suggested upstream: `speechbrain/spkrec-ecapa-voxceleb`
 *      (Apache-2.0). The output dim is fixed at 192 to match the ECAPA
 *      convention; conversion scripts that target a different
 *      embedding width must reproject before packing the GGUF.
 *
 * All three heads share:
 *
 *   - **Audio convention.** Input is mono, 32-bit float (`float`),
 *     samples in `[-1, 1]`, sample rate fixed at 16 kHz. Callers running
 *     at a different rate must pre-resample (the sibling `silero-vad`
 *     library exposes `silero_vad_resample_linear` for that).
 *
 *   - **Mel front-end.** Each head consumes a log-mel spectrogram
 *     (n_mels=80, n_fft=512, hop=160) computed by the shared
 *     `voice_mel_compute` helper in `src/voice_mel_features.c`. The mel
 *     extractor is part of this library, not the model graph, so the
 *     three heads agree on framing and the GGUF only carries the model
 *     weights.
 *
 *   - **Error handling.** All entry points return `int`: zero on
 *     success, negative `errno`-style codes on failure (`-ENOSYS` from
 *     the stub TUs, `-ENOENT` for missing GGUF, `-EINVAL` for shape /
 *     argument mismatch, `-ENOMEM` for allocation failures). On any
 *     non-zero return the function clears its out-parameters so the
 *     caller cannot accidentally read uninitialized memory.
 *
 *   - **Threading.** Reentrant against distinct handles. Sharing one
 *     handle across threads is the caller's mutex problem.
 *
 * The companion stub TUs in `src/voice_classifier_stub.c` return
 * `-ENOSYS` for every model entry point so callers can compile and link
 * against this library while the real ggml-backed port lands. The class
 * names, the cosine-distance helper, and the mel extractor are NOT
 * stubbed — they are real implementations and are used by the test
 * suite today.
 */

#ifndef VOICE_CLASSIFIER_VOICE_CLASSIFIER_H
#define VOICE_CLASSIFIER_VOICE_CLASSIFIER_H

#include <stddef.h>
#include <stdint.h>

/* Visibility: when building the SHARED library
 * (`VOICE_CLASSIFIER_BUILD_SHARED=1`), mark the public C ABI as
 * exported so the rest of the TU keeps `-fvisibility=hidden` to
 * shrink the symbol table and avoid leaking internal helpers. The
 * STATIC library and consumers see the default (visible) attribute. */
#if defined(VOICE_CLASSIFIER_BUILD_SHARED) && (defined(__GNUC__) || defined(__clang__))
#define VOICE_CLASSIFIER_API __attribute__((visibility("default")))
#elif defined(_WIN32) && defined(VOICE_CLASSIFIER_BUILD_SHARED)
#define VOICE_CLASSIFIER_API __declspec(dllexport)
#else
#define VOICE_CLASSIFIER_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- shared audio + feature contract ---------------- */

/* Required input sample rate for every head. Callers running at a
 * different rate must pre-resample. */
#define VOICE_CLASSIFIER_SAMPLE_RATE_HZ 16000

/* Mel front-end parameters. The three heads share this front-end so
 * their GGUFs only carry model weights. */
#define VOICE_CLASSIFIER_N_MELS 80
#define VOICE_CLASSIFIER_N_FFT  512
#define VOICE_CLASSIFIER_HOP    160

/* Output dimensions for the heads with a fixed-shape output. */
#define VOICE_EMOTION_NUM_CLASSES 7
#define VOICE_SPEAKER_EMBEDDING_DIM 192

/* ---------------- emotion classifier ---------------- */

/* Opaque session handle for the emotion head. */
typedef void *voice_emotion_handle;

/*
 * Open an emotion-classifier session against a GGUF file produced by
 * `scripts/voice_emotion_to_gguf.py`. Writes the new handle into `*out`.
 *
 * Returns 0 on success.
 * Returns `-ENOSYS` from the stub.
 * Returns `-ENOENT` if `gguf` does not name a readable file.
 * Returns `-EINVAL` if `out` is NULL or the GGUF's
 *   `voice_emotion.variant` metadata key does not match this header's
 *   pinned variant.
 * On failure `*out` (when non-NULL) is set to NULL.
 */
VOICE_CLASSIFIER_API int voice_emotion_open(const char *gguf, voice_emotion_handle *out);

/*
 * Run the emotion classifier over a mono 16 kHz float-PCM window of
 * length `n` and write 7 soft probabilities into `probs` (in the order
 * documented by `voice_emotion_class_name`).
 *
 * Returns 0 on success and writes a probability vector that sums to ~1.
 * Returns `-EINVAL` on NULL handle, NULL `pcm_16khz`, NULL `probs`, or
 *   zero `n`.
 * Returns `-ENOSYS` from the stub.
 * On failure the `probs` array (when non-NULL) is zeroed.
 */
VOICE_CLASSIFIER_API int voice_emotion_classify(voice_emotion_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           float probs[VOICE_EMOTION_NUM_CLASSES]);

/*
 * Release an emotion-classifier session. NULL-safe.
 *
 * Returns 0 on success, `-ENOSYS` from the stub when called with a
 * non-NULL handle (the stub never produces a real handle, so a non-NULL
 * argument is a misuse the stub surfaces explicitly).
 */
VOICE_CLASSIFIER_API int voice_emotion_close(voice_emotion_handle h);

/*
 * Return the canonical class name for emotion class index `idx`.
 *
 * The class order is fixed and is the contract the GGUF conversion
 * scripts must honor:
 *
 *   0 = neutral
 *   1 = happy
 *   2 = sad
 *   3 = angry
 *   4 = fear
 *   5 = disgust
 *   6 = surprise
 *
 * Returns a pointer to a NUL-terminated static string for valid `idx`,
 * or NULL for out-of-range indices. The returned pointer is valid for
 * the lifetime of the process; callers must not free it.
 */
VOICE_CLASSIFIER_API const char *voice_emotion_class_name(int idx);

/* ---------------- end-of-turn detector ---------------- */

/* Opaque session handle for the EOT head. */
typedef void *voice_eot_handle;

/*
 * Open an EOT detector session against a GGUF file produced by
 * `scripts/voice_eot_to_gguf.py`. Same contract as the other `*_open`
 * entry points. Returns `-ENOSYS` from the stub.
 */
VOICE_CLASSIFIER_API int voice_eot_open(const char *gguf, voice_eot_handle *out);

/*
 * Score a mono 16 kHz float-PCM window for end-of-turn likelihood.
 * Writes a single probability in `[0, 1]` into `*eot_prob`.
 *
 * Returns 0 on success.
 * Returns `-EINVAL` on NULL handle, NULL `pcm_16khz`, NULL `eot_prob`,
 *   or zero `n`.
 * Returns `-ENOSYS` from the stub.
 * On failure `*eot_prob` (when non-NULL) is set to 0.
 */
VOICE_CLASSIFIER_API int voice_eot_score(voice_eot_handle h,
                    const float *pcm_16khz,
                    size_t n,
                    float *eot_prob);

/* Release an EOT session. NULL-safe. */
VOICE_CLASSIFIER_API int voice_eot_close(voice_eot_handle h);

/* ---------------- speaker embedding ---------------- */

/* Opaque session handle for the speaker-embedding head. */
typedef void *voice_speaker_handle;

/*
 * Open a speaker-encoder session against a GGUF file produced by
 * `scripts/voice_speaker_to_gguf.py`. Same contract as the other
 * `*_open` entry points. Returns `-ENOSYS` from the stub.
 */
VOICE_CLASSIFIER_API int voice_speaker_open(const char *gguf, voice_speaker_handle *out);

/*
 * Compute a 192-dim L2-normalized speaker embedding for a mono 16 kHz
 * float-PCM window of length `n` and write it into `embedding`.
 *
 * Returns 0 on success.
 * Returns `-EINVAL` on NULL handle, NULL `pcm_16khz`, NULL `embedding`,
 *   or zero `n`.
 * Returns `-ENOSYS` from the stub.
 * On failure `embedding` (when non-NULL) is zeroed.
 */
VOICE_CLASSIFIER_API int voice_speaker_embed(voice_speaker_handle h,
                        const float *pcm_16khz,
                        size_t n,
                        float embedding[VOICE_SPEAKER_EMBEDDING_DIM]);

/* Release a speaker session. NULL-safe. */
VOICE_CLASSIFIER_API int voice_speaker_close(voice_speaker_handle h);

/*
 * Cosine distance between two 192-dim speaker embeddings. Defined as
 * `1 - cos_similarity(a, b)`, range `[0, 2]`:
 *
 *   identical / parallel       → 0
 *   orthogonal                 → 1
 *   anti-parallel / opposite   → 2
 *
 * Both `a` and `b` must be non-NULL pointers to `VOICE_SPEAKER_EMBEDDING_DIM`
 * floats. Either zero-norm input degenerates the cosine (the function
 * treats a zero-norm vector as orthogonal to everything and returns 1).
 *
 * Real implementation — used by callers and by the test suite.
 */
VOICE_CLASSIFIER_API float voice_speaker_distance(const float *a, const float *b);

/* ---------------- diarizer (pyannote-3) ---------------- */

/* Pyannote-3 segmentation diarizer: SincNet front-end + LSTM +
 * 7-class powerset classifier head. Input: a fixed 10 s mono 16 kHz
 * float window; output: a per-frame label sequence of length T (where
 * T is the model's frame rate for the input window) over the 7
 * powerset classes:
 *
 *   0 = silence
 *   1 = speaker A only
 *   2 = speaker B only
 *   3 = speaker C only
 *   4 = speakers A + B
 *   5 = speakers A + C
 *   6 = speakers B + C
 *
 * The 7-class powerset is the upstream pyannote-3 contract (see
 * `pyannote/Powerset`). Callers consume the per-frame label sequence
 * by running agglomerative clustering across windows; that clustering
 * is JS-side in `services/voice/speaker/diarizer.ts` so this library
 * stays focused on the model forward pass.
 *
 * Output dim is fixed at 7 powerset classes; if the upstream model
 * scales up to more concurrent speakers, the GGUF carries an updated
 * `voice_diarizer.num_classes` metadata key and this library refuses
 * to load it (the JS-side label decoder is hardcoded to 7 today).
 */

#define VOICE_DIARIZER_NUM_CLASSES 7

/* Opaque session handle for the diarizer. */
typedef void *voice_diarizer_handle;

/*
 * Open a diarizer session against a GGUF file produced by
 * `scripts/voice_diarizer_to_gguf.py`. Same contract as the other
 * `*_open` entry points. Returns `-ENOSYS` from the stub.
 */
VOICE_CLASSIFIER_API int voice_diarizer_open(const char *gguf, voice_diarizer_handle *out);

/*
 * Run the diarizer over a mono 16 kHz float-PCM window of length `n`
 * and write the per-frame label sequence into `labels_out` (one
 * int8_t label per frame, in `[0, VOICE_DIARIZER_NUM_CLASSES)`).
 *
 * The caller passes the capacity of `labels_out` in
 * `*frames_capacity_inout`. On success the function sets
 * `*frames_capacity_inout` to the number of labels actually written
 * (`frames_per_window`). On `-ENOSPC` the function does not write to
 * `labels_out` but sets `*frames_capacity_inout` to the required
 * frame count so the caller can resize and re-call.
 *
 * Returns 0 on success.
 * Returns `-EINVAL` on NULL handle / pcm / labels_out, or zero `n`.
 * Returns `-ENOSPC` when `*frames_capacity_inout < frames_per_window`.
 * Returns `-ENOSYS` from the stub.
 * On any failure `labels_out` (when non-NULL and the size was
 * adequate) is zeroed.
 */
VOICE_CLASSIFIER_API int voice_diarizer_segment(voice_diarizer_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           int8_t *labels_out,
                           size_t *frames_capacity_inout);

/* Release a diarizer session. NULL-safe. */
VOICE_CLASSIFIER_API int voice_diarizer_close(voice_diarizer_handle h);

/* ---------------- shared mel front-end ---------------- */

/*
 * Compute a log-mel spectrogram for `n_samples` of mono 16 kHz float
 * PCM. The output layout is row-major
 * `frames * VOICE_CLASSIFIER_N_MELS`, where `frames = 1 + (n_samples -
 * VOICE_CLASSIFIER_N_FFT) / VOICE_CLASSIFIER_HOP` clamped to zero.
 *
 * The caller owns `mel_out` and passes its capacity in `mel_capacity`
 * (counted in floats). On success `*frames_out` is set to the number of
 * frames written; on `-ENOSPC` the function does not write to `mel_out`
 * but sets `*frames_out` to the required frame count so the caller can
 * resize and re-call.
 *
 * Returns 0 on success.
 * Returns `-EINVAL` on NULL pointers or `n_samples < VOICE_CLASSIFIER_N_FFT`.
 * Returns `-ENOSPC` when `mel_capacity < frames * VOICE_CLASSIFIER_N_MELS`.
 *
 * Real implementation — used by all three heads and by the test suite.
 */
VOICE_CLASSIFIER_API int voice_mel_compute(const float *pcm_16khz,
                      size_t n_samples,
                      float *mel_out,
                      size_t mel_capacity,
                      size_t *frames_out);

/* Number of mel frames a window of `n_samples` produces. Returns 0 if
 * the window is too short to fit a single FFT. */
VOICE_CLASSIFIER_API size_t voice_mel_frame_count(size_t n_samples);

/* ---------------- diagnostics ---------------- */

/*
 * Capability string of the active backend. Reflects the *runtime*-
 * selected dispatch path. The stub returns "stub"; the real ggml-backed
 * implementation will return "ggml-cpu", "ggml-metal", etc. Never NULL.
 */
VOICE_CLASSIFIER_API const char *voice_classifier_active_backend(void);

#ifdef __cplusplus
}
#endif

#endif /* VOICE_CLASSIFIER_VOICE_CLASSIFIER_H */
