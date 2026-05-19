/*
 * face_distance.c — cosine + L2 distance between two
 * FACE_EMBED_DIM-vector face embeddings. Real implementation; both
 * inputs are assumed to already be L2-normalized (which is what
 * `face_embed` produces).
 *
 * Cosine distance is defined as `1 - cosine_similarity`; for unit-norm
 * inputs that simplifies to `1 - dot(a, b)`. The output range for
 * unit-norm inputs is [0, 2] inclusive:
 *   identical          → 0
 *   orthogonal         → 1
 *   antipodal (a==-b)  → 2
 *
 * L2 distance for unit-norm inputs has the closed-form
 *   ||a - b||_2 = sqrt(2 - 2 * dot(a, b))
 * which sits in [0, 2] as well.
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
