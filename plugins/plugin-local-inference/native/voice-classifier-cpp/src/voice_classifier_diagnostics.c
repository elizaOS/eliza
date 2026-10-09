/*
 * voice-classifier-cpp — diagnostics surface.
 *
 * `voice_classifier_active_backend()` reports the runtime-selected
 * dispatch path. Today the four heads share a single string compiled
 * at build time:
 *
 *   "ggml-cpu-shape"  — when the heads accept a GGUF and validate its
 *                       metadata block, but the forward graph is not
 *                       yet implemented (the J1.a / J1.b / J1.c
 *                       follow-ups land the graph).
 *   "stub"            — legacy build with only the ENOSYS stub.
 *
 * The TS GGML surfaces read this string to choose between "raise a
 * structured `native-stub` error" and "raise a structured
 * `native-forward-not-implemented` error" — both fail fast, neither
 * fabricates a probability, but the second is a more precise read
 * for the bench-harness telemetry to record.
 */

#include "voice_classifier/voice_classifier.h"

const char *voice_classifier_active_backend(void) {
    return "ggml-cpu-shape";
}
