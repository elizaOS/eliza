/**
 * Compares face embeddings produced by the native embedder. Callers must
 * supply L2-normalized FACE_EMBED_DIM vectors from the same model family;
 * cosine and L2 distances then range from zero (identical) to two (opposite).
 */

#include "face/face.h"

#include <math.h>
#include <stddef.h>

float face_embed_distance(const float *a, const float *b) {
    if (!a || !b) return 2.0f;
    float dot = 0.0f;
    for (int i = 0; i < FACE_EMBED_DIM; ++i) {
        dot += a[i] * b[i];
    }
    /* Clamp to [-1, 1] to keep the output strictly in [0, 2] in the
     * face of accumulated FP error on already-normalized inputs. */
    if (dot >  1.0f) dot =  1.0f;
    if (dot < -1.0f) dot = -1.0f;
    return 1.0f - dot;
}

float face_embed_distance_l2(const float *a, const float *b) {
    if (!a || !b) return 2.0f;
    float sum = 0.0f;
    for (int i = 0; i < FACE_EMBED_DIM; ++i) {
        const float d = a[i] - b[i];
        sum += d * d;
    }
    return sqrtf(sum);
}
