/*
 * voice-classifier-cpp — open/close smoke test.
 *
 * Confirms the public C ABI in
 * `include/voice_classifier/voice_classifier.h` links, that every
 * `*_open` against a non-existent GGUF returns `-ENOENT` (the real
 * loader's behavior, not the legacy `-ENOSYS` from the old single-TU
 * stub), and that every `*_classify/embed/score/segment` forward
 * entry returns `-ENOSYS` from the placeholder graph while still
 * clearing its out-parameters.
 *
 * The previous version of this test (before the J1 infrastructure
 * refactor) expected `*_open` itself to return `-ENOSYS`. That was a
 * single shared `voice_classifier_stub.c` TU; the new per-head TUs
 * (`voice_emotion.c`, `voice_speaker.c`, `voice_eot.c`,
 * `voice_diarizer.c`) load + validate the GGUF metadata block before
 * declining the forward pass. This test pins the new contract.
 */

#include "voice_classifier/voice_classifier.h"

#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    /* Active-backend string: must be one of "stub" (legacy) or
     * "ggml-cpu-shape" (J1 infrastructure). Anything else is a bug. */
    const char *backend = voice_classifier_active_backend();
    if (strcmp(backend, "ggml-cpu-shape") != 0 &&
        strcmp(backend, "stub") != 0) {
        fprintf(stderr,
                "[voice-classifier-smoke] unexpected backend: %s\n",
                backend);
        ++failures;
    }

    /* ---------------- emotion ---------------- */
    voice_emotion_handle eh = (voice_emotion_handle)0x1;
    int rc = voice_emotion_open("/nonexistent.gguf", &eh);
    if (rc != -ENOENT && rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_emotion_open(/nonexistent) returned %d, expected -ENOENT (%d) or -ENOSYS (%d)\n",
                rc, -ENOENT, -ENOSYS);
        ++failures;
    }
    if (eh != NULL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_emotion_open did not clear out handle on failure\n");
        ++failures;
    }

    float pcm[16] = {0};
    float probs[VOICE_EMOTION_NUM_CLASSES];
    for (int i = 0; i < VOICE_EMOTION_NUM_CLASSES; ++i) probs[i] = 9.0f;
    rc = voice_emotion_classify(NULL, pcm, 16, probs);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_emotion_classify(NULL) returned %d, expected -EINVAL\n",
                rc);
        ++failures;
    }
    for (int i = 0; i < VOICE_EMOTION_NUM_CLASSES; ++i) {
        if (probs[i] != 0.0f) {
            fprintf(stderr,
                    "[voice-classifier-smoke] voice_emotion_classify did not zero probs[%d]\n",
                    i);
            ++failures;
            break;
        }
    }
    /* NULL-handle close is a no-op success. */
    if (voice_emotion_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_emotion_close(NULL) was not a no-op\n");
        ++failures;
    }

    /* ---------------- end-of-turn ---------------- */
    voice_eot_handle th = (voice_eot_handle)0x1;
    rc = voice_eot_open("/nonexistent.gguf", &th);
    if (rc != -ENOENT && rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_eot_open(/nonexistent) returned %d, expected -ENOENT (%d) or -ENOSYS (%d)\n",
                rc, -ENOENT, -ENOSYS);
        ++failures;
    }
    if (th != NULL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_eot_open did not clear out handle\n");
        ++failures;
    }
    float p = 9.0f;
    rc = voice_eot_score(NULL, pcm, 16, &p);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_eot_score(NULL) returned %d, expected -EINVAL\n",
                rc);
        ++failures;
    }
    if (p != 0.0f) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_eot_score did not zero eot_prob\n");
        ++failures;
    }
    if (voice_eot_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_eot_close(NULL) was not a no-op\n");
        ++failures;
    }

    /* ---------------- speaker ---------------- */
    voice_speaker_handle sh = (voice_speaker_handle)0x1;
    rc = voice_speaker_open("/nonexistent.gguf", &sh);
    if (rc != -ENOENT && rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_speaker_open(/nonexistent) returned %d, expected -ENOENT (%d) or -ENOSYS (%d)\n",
                rc, -ENOENT, -ENOSYS);
        ++failures;
    }
    if (sh != NULL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_speaker_open did not clear out handle\n");
        ++failures;
    }
    float emb[VOICE_SPEAKER_EMBEDDING_DIM];
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) emb[i] = 9.0f;
    rc = voice_speaker_embed(NULL, pcm, 16, emb);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_speaker_embed(NULL) returned %d, expected -EINVAL\n",
                rc);
        ++failures;
    }
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        if (emb[i] != 0.0f) {
            fprintf(stderr,
                    "[voice-classifier-smoke] voice_speaker_embed did not zero embedding[%d]\n",
                    i);
            ++failures;
            break;
        }
    }
    if (voice_speaker_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_speaker_close(NULL) was not a no-op\n");
        ++failures;
    }

    /* ---------------- diarizer ---------------- */
    voice_diarizer_handle dh = (voice_diarizer_handle)0x1;
    rc = voice_diarizer_open("/nonexistent.gguf", &dh);
    if (rc != -ENOENT && rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_diarizer_open(/nonexistent) returned %d, expected -ENOENT (%d) or -ENOSYS (%d)\n",
                rc, -ENOENT, -ENOSYS);
        ++failures;
    }
    if (dh != NULL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_diarizer_open did not clear out handle\n");
        ++failures;
    }
    int8_t labels[1024];
    for (int i = 0; i < 1024; ++i) labels[i] = (int8_t)0x55;
    size_t cap = sizeof(labels) / sizeof(labels[0]);
    rc = voice_diarizer_segment(NULL, pcm, 16, labels, &cap);
    if (rc != -EINVAL) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_diarizer_segment(NULL) returned %d, expected -EINVAL\n",
                rc);
        ++failures;
    }
    if (voice_diarizer_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-smoke] voice_diarizer_close(NULL) was not a no-op\n");
        ++failures;
    }

    printf("[voice-classifier-smoke] failures=%d backend=%s\n", failures, backend);
    return failures == 0 ? 0 : 1;
}
