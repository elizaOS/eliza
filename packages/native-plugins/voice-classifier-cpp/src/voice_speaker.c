/*
 * voice-classifier-cpp — speaker head (J1.b infrastructure).
 *
 * GGUF metadata loader + handle lifecycle for the WeSpeaker ResNet34-LM
 * / ECAPA-TDNN speaker encoder. The forward pass returns -ENOSYS until
 * the ResNet34 backbone + statistics-pool graph is ported to ggml
 * (J1.b follow-up). Same rationale as `voice_emotion.c`: opening the
 * GGUF now produces a real handle, so the TS GGML surface can
 * distinguish "GGUF missing / wrong shape" from "graph not yet wired".
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

struct voice_speaker_session {
    voice_gguf_metadata_t meta;
    char gguf_path[1024];
};

int voice_speaker_open(const char *gguf, voice_speaker_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    const int rc = voice_gguf_load_metadata(gguf, "voice_speaker", &meta);
    if (rc != 0) return rc;

    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    if (meta.n_mels != 0 && meta.n_mels != VOICE_CLASSIFIER_N_MELS) return -EINVAL;
    if (meta.n_fft != 0 && meta.n_fft != VOICE_CLASSIFIER_N_FFT) return -EINVAL;
    if (meta.hop != 0 && meta.hop != VOICE_CLASSIFIER_HOP) return -EINVAL;
    /* The C ABI is pinned to 192-dim (ECAPA convention). WeSpeaker
     * ResNet34-LM produces 256-dim; conversion scripts that target a
     * 192-dim head MUST set this key to 192 to acknowledge the
     * re-projection. Refuse mismatched dims loudly. */
    if (meta.embedding_dim != 0 &&
        meta.embedding_dim != VOICE_SPEAKER_EMBEDDING_DIM) return -EINVAL;

    struct voice_speaker_session *s =
        (struct voice_speaker_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);
    *out = (voice_speaker_handle)s;
    return 0;
}

int voice_speaker_embed(voice_speaker_handle h,
                        const float *pcm_16khz,
                        size_t n,
                        float embedding[VOICE_SPEAKER_EMBEDDING_DIM]) {
    if (embedding) {
        memset(embedding, 0, sizeof(float) * VOICE_SPEAKER_EMBEDDING_DIM);
    }
    if (!h || !pcm_16khz || !embedding || n == 0) return -EINVAL;
    /* TODO(J1.b-forward): port the ResNet34 + stats-pool graph to
     * ggml. */
    return -ENOSYS;
}

int voice_speaker_close(voice_speaker_handle h) {
    if (h == NULL) return 0;
    free(h);
    return 0;
}
