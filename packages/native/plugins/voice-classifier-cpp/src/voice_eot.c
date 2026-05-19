/*
 * voice-classifier-cpp — audio-side EOT head.
 *
 * This is the audio-side semantic end-of-turn classifier — distinct
 * from the text-side `LiveKitTurnDetector` (which J1.d wired to the
 * fork's GGUF via node-llama-cpp). The audio-side detector reads
 * P(end_of_turn) from a short audio window. No upstream model has
 * been pinned yet — the runtime can fuse this signal with the
 * text-side EOT for a stronger combined read, but the audio-side
 * classifier is OPTIONAL at the pipeline level.
 *
 * Today: GGUF-load + metadata-validation only. Forward pass is
 * compute-gated on upstream model selection (the brief calls out
 * `livekit/turn-detector` audio variants or `pipecat-ai/turn` as
 * candidates; neither is locked in yet).
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

struct voice_eot_session {
    voice_gguf_metadata_t meta;
    char gguf_path[1024];
};

int voice_eot_open(const char *gguf, voice_eot_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    const int rc = voice_gguf_load_metadata(gguf, "voice_eot", &meta);
    if (rc != 0) return rc;

    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    if (meta.n_mels != 0 && meta.n_mels != VOICE_CLASSIFIER_N_MELS) return -EINVAL;
    if (meta.n_fft != 0 && meta.n_fft != VOICE_CLASSIFIER_N_FFT) return -EINVAL;
    if (meta.hop != 0 && meta.hop != VOICE_CLASSIFIER_HOP) return -EINVAL;

    struct voice_eot_session *s =
        (struct voice_eot_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);
    *out = (voice_eot_handle)s;
    return 0;
}

int voice_eot_score(voice_eot_handle h,
                    const float *pcm_16khz,
                    size_t n,
                    float *eot_prob) {
    if (eot_prob) *eot_prob = 0.0f;
    if (!h || !pcm_16khz || !eot_prob || n == 0) return -EINVAL;
    /* TODO: pin upstream + port forward graph. */
    return -ENOSYS;
}

int voice_eot_close(voice_eot_handle h) {
    if (h == NULL) return 0;
    free(h);
    return 0;
}
