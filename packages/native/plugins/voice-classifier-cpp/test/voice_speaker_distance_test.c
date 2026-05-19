/*
 * voice_speaker_distance unit test.
 *
 * Verifies the cosine-distance contract:
 *   identical vectors      → 0
 *   orthogonal vectors     → 1
 *   anti-parallel vectors  → 2
 *   zero-norm input        → 1 (degenerate / "no information")
 *
 * The function is also expected to handle inputs that are NOT
 * pre-L2-normalized — the runtime helper averages embeddings before
 * comparing in some paths and we don't want to require a separate
 * normalization step.
 */

#include "voice_classifier/voice_classifier.h"

#include <math.h>
#include <stdio.h>

static int approx(float got, float expected, float tol, const char *label) {
    if (fabsf(got - expected) > tol) {
        fprintf(stderr,
                "[voice-speaker-distance] %s: got %.6f, expected %.6f (tol %.6f)\n",
                label, got, expected, tol);
        return 0;
    }
    return 1;
}

int main(void) {
    int failures = 0;

    float a[VOICE_SPEAKER_EMBEDDING_DIM];
    float b[VOICE_SPEAKER_EMBEDDING_DIM];
    float zero[VOICE_SPEAKER_EMBEDDING_DIM];

    /* Identical: a == b == [1, 1, ..., 1]. */
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        a[i] = 1.0f;
        b[i] = 1.0f;
        zero[i] = 0.0f;
    }
    if (!approx(voice_speaker_distance(a, b), 0.0f, 1e-5f, "identical")) ++failures;

    /* Identical (different magnitudes — cosine is scale-invariant). */
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        a[i] = 3.0f;
        b[i] = 0.25f;
    }
    if (!approx(voice_speaker_distance(a, b), 0.0f, 1e-5f, "parallel-different-magnitude")) ++failures;

    /* Anti-parallel: a == -b. */
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        a[i] = 1.0f;
        b[i] = -1.0f;
    }
    if (!approx(voice_speaker_distance(a, b), 2.0f, 1e-5f, "anti-parallel")) ++failures;

    /* Orthogonal: split the embedding into two halves and put non-zero
     * mass in disjoint halves. dot product = 0. */
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) {
        a[i] = (i < VOICE_SPEAKER_EMBEDDING_DIM / 2) ? 1.0f : 0.0f;
        b[i] = (i < VOICE_SPEAKER_EMBEDDING_DIM / 2) ? 0.0f : 1.0f;
    }
    if (!approx(voice_speaker_distance(a, b), 1.0f, 1e-5f, "orthogonal")) ++failures;

    /* Zero-norm input → 1 (treated as no information rather than NaN). */
    for (int i = 0; i < VOICE_SPEAKER_EMBEDDING_DIM; ++i) a[i] = 1.0f;
    if (!approx(voice_speaker_distance(a, zero), 1.0f, 1e-5f, "zero-norm-b")) ++failures;
    if (!approx(voice_speaker_distance(zero, a), 1.0f, 1e-5f, "zero-norm-a")) ++failures;
    if (!approx(voice_speaker_distance(zero, zero), 1.0f, 1e-5f, "zero-norm-both")) ++failures;

    /* NULL inputs are also "no information". */
    if (!approx(voice_speaker_distance(NULL, a), 1.0f, 1e-5f, "null-a")) ++failures;
    if (!approx(voice_speaker_distance(a, NULL), 1.0f, 1e-5f, "null-b")) ++failures;

    printf("[voice-speaker-distance] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
