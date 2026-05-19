/*
 * voice-classifier-cpp — emotion class-name table.
 *
 * The 7-class basic-emotion vocabulary is a *contract* shared by:
 *
 *   - the GGUF conversion script (`scripts/voice_emotion_to_gguf.py`),
 *     which must pack head logits in this exact order;
 *   - the runtime decode in the (eventual) real emotion TU, which reads
 *     the GGUF logits in this order without any remap;
 *   - the TS binding (`voice-emotion-classifier-ggml.ts`), which surfaces
 *     these names to callers verbatim.
 *
 * Class order is locked at:
 *
 *   0 = neutral
 *   1 = happy
 *   2 = sad
 *   3 = angry
 *   4 = fear
 *   5 = disgust
 *   6 = surprise
 *
 * Anything depending on this order needs to be updated together with
 * this file. The test in `test/voice_emotion_classes_test.c` enforces
 * the order so a silent reorder fails CI.
 */

#include "voice_classifier/voice_classifier.h"

#include <stddef.h>

static const char *const kClassNames[VOICE_EMOTION_NUM_CLASSES] = {
    "neutral",
    "happy",
    "sad",
    "angry",
    "fear",
    "disgust",
    "surprise",
};

const char *voice_emotion_class_name(int idx) {
    if (idx < 0 || idx >= VOICE_EMOTION_NUM_CLASSES) {
        return NULL;
    }
    return kClassNames[idx];
}
