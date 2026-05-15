/*
 * voice-classifier-cpp — ENOSYS stub for the three model heads.
 *
 * This translation unit satisfies the model-side entry points declared
 * in `include/voice_classifier/voice_classifier.h`. The real ports
 * (emotion / EOT / speaker) replace these symbols when the ggml-backed
 * implementations land. The class-name table, the cosine-distance
 * helper, and the mel front-end live in their own translation units —
 * those are real implementations and are NOT stubbed.
 *
 * Every entry point here clears its out-parameters before returning so
 * a caller that ignores the return code cannot read uninitialized
 * memory.
 */

#include "voice_classifier/voice_classifier.h"

#include <errno.h>
#include <stddef.h>
#include <string.h>

/* ---------------- emotion ---------------- */

int voice_emotion_open(const char *gguf, voice_emotion_handle *out) {
    (void)gguf;
    if (out) *out = NULL;
    return -ENOSYS;
}

int voice_emotion_classify(voice_emotion_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           float probs[VOICE_EMOTION_NUM_CLASSES]) {
    (void)h;
    (void)pcm_16khz;
    (void)n;
    if (probs) {
        memset(probs, 0, sizeof(float) * VOICE_EMOTION_NUM_CLASSES);
    }
    return -ENOSYS;
}

int voice_emotion_close(voice_emotion_handle h) {
    if (h == NULL) return 0;
    return -ENOSYS;
}

/* ---------------- end-of-turn ---------------- */

int voice_eot_open(const char *gguf, voice_eot_handle *out) {
    (void)gguf;
    if (out) *out = NULL;
    return -ENOSYS;
}

int voice_eot_score(voice_eot_handle h,
                    const float *pcm_16khz,
                    size_t n,
                    float *eot_prob) {
    (void)h;
    (void)pcm_16khz;
    (void)n;
    if (eot_prob) *eot_prob = 0.0f;
    return -ENOSYS;
}

int voice_eot_close(voice_eot_handle h) {
    if (h == NULL) return 0;
    return -ENOSYS;
}

/* ---------------- speaker ---------------- */

int voice_speaker_open(const char *gguf, voice_speaker_handle *out) {
    (void)gguf;
    if (out) *out = NULL;
    return -ENOSYS;
}

int voice_speaker_embed(voice_speaker_handle h,
                        const float *pcm_16khz,
                        size_t n,
                        float embedding[VOICE_SPEAKER_EMBEDDING_DIM]) {
    (void)h;
    (void)pcm_16khz;
    (void)n;
    if (embedding) {
        memset(embedding, 0, sizeof(float) * VOICE_SPEAKER_EMBEDDING_DIM);
    }
    return -ENOSYS;
}

int voice_speaker_close(voice_speaker_handle h) {
    if (h == NULL) return 0;
    return -ENOSYS;
}

/* ---------------- diagnostics ---------------- */

const char *voice_classifier_active_backend(void) {
    return "stub";
}
