/*
 * voice-classifier-cpp — emotion head (J1.a infrastructure).
 *
 * Today this TU implements the GGUF-load + metadata-validation half of
 * the J1.a port (Wav2Small emotion classifier). It opens the GGUF,
 * validates that the metadata block matches the C-side ABI contract
 * (sample rate, n_mels, n_fft, hop, num_classes), and returns a real
 * heap-allocated handle. The forward pass (`voice_emotion_classify`)
 * still returns `-ENOSYS` until the ggml graph lands — that work is
 * gated on the conversion script producing real tensors, which is the
 * J1.a follow-up.
 *
 * Why this is useful even pre-forward: TS callers can now distinguish
 * "GGUF is missing / wrong shape" (open fails, structured -ENOENT /
 * -EINVAL) from "GGUF parsed but graph not implemented" (open
 * succeeds, classify returns -ENOSYS). The voice pipeline can fall
 * back to the legacy ONNX path with a clearer error code.
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

/* Concrete handle struct — opaque to callers. */
struct voice_emotion_session {
    voice_gguf_metadata_t meta;
    char gguf_path[1024];
};

int voice_emotion_open(const char *gguf, voice_emotion_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    const int rc = voice_gguf_load_metadata(gguf, "voice_emotion", &meta);
    if (rc != 0) return rc;

    /* Locked ABI contract — refuse mismatched bundles loudly per
     * AGENTS.md §3 "no silent fallback". */
    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    if (meta.n_mels != 0 && meta.n_mels != VOICE_CLASSIFIER_N_MELS) return -EINVAL;
    if (meta.n_fft != 0 && meta.n_fft != VOICE_CLASSIFIER_N_FFT) return -EINVAL;
    if (meta.hop != 0 && meta.hop != VOICE_CLASSIFIER_HOP) return -EINVAL;
    if (meta.num_classes != 0 &&
        meta.num_classes != VOICE_EMOTION_NUM_CLASSES) return -EINVAL;

    struct voice_emotion_session *s =
        (struct voice_emotion_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);
    *out = (voice_emotion_handle)s;
    return 0;
}

int voice_emotion_classify(voice_emotion_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           float probs[VOICE_EMOTION_NUM_CLASSES]) {
    if (probs) {
        memset(probs, 0, sizeof(float) * VOICE_EMOTION_NUM_CLASSES);
    }
    if (!h || !pcm_16khz || !probs || n == 0) return -EINVAL;
    /* TODO(J1.a-forward): port the Wav2Small CNN + Transformer graph
     * to ggml. The metadata-load path is real (commit ${this}); the
     * forward pass is the follow-up. */
    return -ENOSYS;
}

int voice_emotion_close(voice_emotion_handle h) {
    if (h == NULL) return 0;
    free(h);
    return 0;
}
