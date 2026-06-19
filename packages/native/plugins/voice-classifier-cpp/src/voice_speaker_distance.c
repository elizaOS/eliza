/*
 * voice-classifier-cpp — speaker embedding cosine distance.
 *
 * Defined as `1 - cos_similarity(a, b)`, range `[0, 2]`:
 *   identical / parallel    → 0
 *   orthogonal              → 1
 *   anti-parallel           → 2
 *
 * The function does NOT assume the inputs are pre-L2-normalized — the
 * speaker encoder TUs do normalize before returning, but the helper is
 * also exposed to callers (TS bindings, downstream code paths) that may
 * average a small set of embeddings before comparing. Computing the
 * full normalized cosine here avoids a second normalization pass at the
 * boundary.
 *
 * A zero-norm input is treated as orthogonal to everything (returns 1)
 * rather than producing a NaN. That matches what callers want when an
 * embedding has been zeroed by an upstream error path: the comparison
 * is "no information" rather than "perfectly different".
 */

#include "voice_classifier/voice_classifier.h"

#include <math.h>
#include <stddef.h>

float voice_speaker_distance(const float *a, const float *b) {
    if (a == NULL || b == NULL) {
        return 1.0f;
    }

    double dot = 0.0;
    double norm_a = 0.0;
    double norm_b = 0.0;

    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        const double av = (double)a[i];
        const double bv = (double)b[i];
        dot    += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }

    if (norm_a <= 0.0 || norm_b <= 0.0) {
        return 1.0f;
    }

    const double cosine = dot / (sqrt(norm_a) * sqrt(norm_b));
    /* Clamp into [-1, 1] before subtracting; floating-point dot/norm can
     * drift by a few ULPs on parallel-or-anti-parallel pairs. */
    double clamped = cosine;
    if (clamped >  1.0) clamped =  1.0;
    if (clamped < -1.0) clamped = -1.0;
    return (float)(1.0 - clamped);
}
