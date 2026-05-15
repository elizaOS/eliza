/*
 * Behavioural test for `face_embed_distance` (cosine) and
 * `face_embed_distance_l2`.
 *
 * For unit-norm 128-d vectors:
 *   identical    → cos dist = 0,           L2 = 0
 *   orthogonal   → cos dist = 1,           L2 = sqrt(2) ≈ 1.4142
 *   antipodal    → cos dist = 2,           L2 = 2
 *
 * Tolerance is generous because we accumulate FP error across 128
 * additions; the contract is "functionally correct", not "bit-exact".
 */

#include "face/face.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static int approx(float a, float b, float tol) {
    return fabsf(a - b) <= tol;
}

int main(void) {
    int failures = 0;

    /* Identical: e0 = (1, 0, ..., 0) */
    float e0[FACE_EMBED_DIM] = {0};
    e0[0] = 1.0f;

    float cd = face_embed_distance(e0, e0);
    if (!approx(cd, 0.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] identical cos: got %f expected ~0\n", cd);
        ++failures;
    }
    float ld = face_embed_distance_l2(e0, e0);
    if (!approx(ld, 0.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] identical L2: got %f expected ~0\n", ld);
        ++failures;
    }

    /* Orthogonal: e1 = (0, 1, 0, ..., 0) */
    float e1[FACE_EMBED_DIM] = {0};
    e1[1] = 1.0f;

    cd = face_embed_distance(e0, e1);
    if (!approx(cd, 1.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] orthogonal cos: got %f expected ~1\n", cd);
        ++failures;
    }
    ld = face_embed_distance_l2(e0, e1);
    if (!approx(ld, sqrtf(2.0f), 1e-5f)) {
        fprintf(stderr, "[face-distance] orthogonal L2: got %f expected ~sqrt(2)\n", ld);
        ++failures;
    }

    /* Antipodal: e_neg = -e0 */
    float e_neg[FACE_EMBED_DIM] = {0};
    e_neg[0] = -1.0f;

    cd = face_embed_distance(e0, e_neg);
    if (!approx(cd, 2.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] antipodal cos: got %f expected ~2\n", cd);
        ++failures;
    }
    ld = face_embed_distance_l2(e0, e_neg);
    if (!approx(ld, 2.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] antipodal L2: got %f expected ~2\n", ld);
        ++failures;
    }

    /* Symmetry: d(a, b) == d(b, a) for arbitrary unit vectors. */
    float a[FACE_EMBED_DIM];
    float b[FACE_EMBED_DIM];
    float na = 0.0f, nb = 0.0f;
    for (int i = 0; i < FACE_EMBED_DIM; ++i) {
        a[i] = (float)((i * 13) % 7) - 3.0f;
        b[i] = (float)((i * 11 + 5) % 9) - 4.0f;
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    na = sqrtf(na); nb = sqrtf(nb);
    for (int i = 0; i < FACE_EMBED_DIM; ++i) {
        a[i] /= na;
        b[i] /= nb;
    }
    const float dab = face_embed_distance(a, b);
    const float dba = face_embed_distance(b, a);
    if (!approx(dab, dba, 1e-5f)) {
        fprintf(stderr, "[face-distance] not symmetric: %f vs %f\n", dab, dba);
        ++failures;
    }
    /* Output range invariant: 0 <= d <= 2 for unit-norm inputs. */
    if (dab < 0.0f || dab > 2.0f) {
        fprintf(stderr, "[face-distance] out of [0,2]: %f\n", dab);
        ++failures;
    }

    /* NULL safety: returns 2.0 sentinel without crashing. */
    cd = face_embed_distance(NULL, e0);
    if (!approx(cd, 2.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] NULL handling cos: got %f\n", cd);
        ++failures;
    }
    ld = face_embed_distance_l2(NULL, e0);
    if (!approx(ld, 2.0f, 1e-5f)) {
        fprintf(stderr, "[face-distance] NULL handling L2: got %f\n", ld);
        ++failures;
    }

    printf("[face-distance-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
