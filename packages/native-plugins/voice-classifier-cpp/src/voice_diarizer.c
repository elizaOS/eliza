/*
 * voice-classifier-cpp — diarizer head (J1.c infrastructure).
 *
 * GGUF metadata loader + handle lifecycle for the Pyannote-3
 * segmentation diarizer. The forward pass returns -ENOSYS until the
 * SincNet + LSTM + 7-class powerset graph is ported to ggml (J1.c
 * follow-up). Mirrors `voice_emotion.c` / `voice_speaker.c`.
 *
 * The 7-class powerset output is documented in voice_classifier.h —
 * the per-frame label sequence is critical correctness (per H2.b):
 * the classifier head emits powerset labels, not raw per-speaker
 * sigmoids, and conflating the two would mis-attribute every overlap.
 */

#include "voice_classifier/voice_classifier.h"
#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

struct voice_diarizer_session {
    voice_gguf_metadata_t meta;
    char gguf_path[1024];
};

int voice_diarizer_open(const char *gguf, voice_diarizer_handle *out) {
    if (out) *out = NULL;
    if (!gguf || !out) return -EINVAL;

    voice_gguf_metadata_t meta;
    const int rc = voice_gguf_load_metadata(gguf, "voice_diarizer", &meta);
    if (rc != 0) return rc;

    if (meta.sample_rate != 0 &&
        meta.sample_rate != VOICE_CLASSIFIER_SAMPLE_RATE_HZ) return -EINVAL;
    /* Pyannote uses its own SincNet front-end, not the shared mel
     * spec, so n_mels / n_fft / hop may legitimately be zero or
     * differ. We do NOT reject on those here. */
    /* Refuse mismatched class count loudly — if a future Pyannote
     * variant ships with more powerset classes, the JS-side label
     * decoder needs to be updated in lockstep. */
    if (meta.num_classes != 0 &&
        meta.num_classes != VOICE_DIARIZER_NUM_CLASSES) return -EINVAL;

    struct voice_diarizer_session *s =
        (struct voice_diarizer_session *)calloc(1, sizeof(*s));
    if (!s) return -ENOMEM;
    s->meta = meta;
    strncpy(s->gguf_path, gguf, sizeof(s->gguf_path) - 1);
    *out = (voice_diarizer_handle)s;
    return 0;
}

int voice_diarizer_segment(voice_diarizer_handle h,
                           const float *pcm_16khz,
                           size_t n,
                           int8_t *labels_out,
                           size_t *frames_capacity_inout) {
    if (!h || !pcm_16khz || !labels_out || !frames_capacity_inout ||
        n == 0) {
        if (frames_capacity_inout) *frames_capacity_inout = 0;
        return -EINVAL;
    }
    /* TODO(J1.c-forward): port the SincNet + LSTM + powerset
     * classifier head to ggml. Pyannote-3.0's checkpoint is MIT, the
     * wider toolkit is CC-BY-NC — the checkpoint license is what
     * matters here. */
    *frames_capacity_inout = 0;
    return -ENOSYS;
}

int voice_diarizer_close(voice_diarizer_handle h) {
    if (h == NULL) return 0;
    free(h);
    return 0;
}
