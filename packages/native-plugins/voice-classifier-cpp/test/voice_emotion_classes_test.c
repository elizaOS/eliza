/*
 * voice_emotion_class_name parity test.
 *
 * Locks the 7-class basic-emotion vocabulary order. The conversion
 * scripts pack head logits in this exact order, the runtime decode
 * reads them in this order, and the TS binding surfaces them by index.
 * A silent reorder would break end-to-end attribution; this test makes
 * the reorder loud.
 */

#include "voice_classifier/voice_classifier.h"

#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    static const char *expected[VOICE_EMOTION_NUM_CLASSES] = {
        "neutral",
        "happy",
        "sad",
        "angry",
        "fear",
        "disgust",
        "surprise",
    };

    for (int i = 0; i < VOICE_EMOTION_NUM_CLASSES; ++i) {
        const char *name = voice_emotion_class_name(i);
        if (name == NULL) {
            fprintf(stderr,
                    "[voice-emotion-classes] index %d returned NULL; expected '%s'\n",
                    i, expected[i]);
            ++failures;
            continue;
        }
        if (strcmp(name, expected[i]) != 0) {
            fprintf(stderr,
                    "[voice-emotion-classes] index %d: got '%s', expected '%s'\n",
                    i, name, expected[i]);
            ++failures;
        }
    }

    /* Out-of-bounds returns NULL — never a placeholder string. */
    if (voice_emotion_class_name(-1) != NULL) {
        fprintf(stderr, "[voice-emotion-classes] index -1 should return NULL\n");
        ++failures;
    }
    if (voice_emotion_class_name(VOICE_EMOTION_NUM_CLASSES) != NULL) {
        fprintf(stderr,
                "[voice-emotion-classes] index %d should return NULL\n",
                VOICE_EMOTION_NUM_CLASSES);
        ++failures;
    }
    if (voice_emotion_class_name(1000) != NULL) {
        fprintf(stderr, "[voice-emotion-classes] index 1000 should return NULL\n");
        ++failures;
    }

    printf("[voice-emotion-classes] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
