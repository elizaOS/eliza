/*
 * Build-only smoke test for the voice-classifier-cpp ENOSYS stub.
 *
 * Confirms the model-side C ABI declared in
 * `include/voice_classifier/voice_classifier.h` links and that every
 * stubbed entry point reports `-ENOSYS` while clearing its
 * out-parameters. The class-name table, cosine distance helper, and
 * mel front-end are exercised by their own dedicated tests; this test
 * is just the "the ABI still compiles and stays honest about being a
 * stub" guard.
 */

#include "voice_classifier/voice_classifier.h"

#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(voice_classifier_active_backend(), "stub") != 0) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] unexpected backend: %s\n",
                voice_classifier_active_backend());
        ++failures;
    }

    /* ---------------- emotion ---------------- */
    voice_emotion_handle eh = (voice_emotion_handle)0x1;
    int rc = voice_emotion_open("/nonexistent.gguf", &eh);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_emotion_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (eh != NULL) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_emotion_open did not clear out handle\n");
        ++failures;
    }

    float pcm[16] = {0};
    float probs[VOICE_EMOTION_NUM_CLASSES];
    for (int i = 0; i < VOICE_EMOTION_NUM_CLASSES; ++i) probs[i] = 9.0f;
    rc = voice_emotion_classify(NULL, pcm, 16, probs);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_emotion_classify returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    for (int i = 0; i < VOICE_EMOTION_NUM_CLASSES; ++i) {
        if (probs[i] != 0.0f) {
            fprintf(stderr,
                    "[voice-classifier-stub-smoke] voice_emotion_classify did not zero probs[%d]\n",
                    i);
            ++failures;
            break;
        }
    }
    /* NULL-handle close is a no-op success even from the stub. */
    if (voice_emotion_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_emotion_close(NULL) was not a no-op\n");
        ++failures;
    }

    /* ---------------- end-of-turn ---------------- */
    voice_eot_handle th = (voice_eot_handle)0x1;
    rc = voice_eot_open("/nonexistent.gguf", &th);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_eot_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (th != NULL) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_eot_open did not clear out handle\n");
        ++failures;
    }
    float p = 9.0f;
    rc = voice_eot_score(NULL, pcm, 16, &p);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_eot_score returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (p != 0.0f) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_eot_score did not zero eot_prob\n");
        ++failures;
    }
    if (voice_eot_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_eot_close(NULL) was not a no-op\n");
        ++failures;
    }

    /* ---------------- speaker ---------------- */
    voice_speaker_handle sh = (voice_speaker_handle)0x1;
    rc = voice_speaker_open("/nonexistent.gguf", &sh);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_speaker_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (sh != NULL) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_speaker_open did not clear out handle\n");
        ++failures;
    }
    float emb[VOICE_SPEAKER_EMBEDDING_DIM];
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) emb[i] = 9.0f;
    rc = voice_speaker_embed(NULL, pcm, 16, emb);
    if (rc != -ENOSYS) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_speaker_embed returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        if (emb[i] != 0.0f) {
            fprintf(stderr,
                    "[voice-classifier-stub-smoke] voice_speaker_embed did not zero embedding[%d]\n",
                    i);
            ++failures;
            break;
        }
    }
    if (voice_speaker_close(NULL) != 0) {
        fprintf(stderr,
                "[voice-classifier-stub-smoke] voice_speaker_close(NULL) was not a no-op\n");
        ++failures;
    }

    printf("[voice-classifier-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
