/*
 * Behavioural test for the BlazeFace anchor generator + decoder.
 *
 * Verifies:
 *   1. The anchor table for the 128x128 front model has exactly
 *      FACE_DETECTOR_ANCHOR_COUNT (896) entries split as 512 (stride
 *      8, 2-per-cell) + 384 (stride 16, 6-per-cell).
 *   2. Every anchor centre lives in [0, 1].
 *   3. The first stride-8 anchors land on the expected (0, 0) cell
 *      centre of (0.5/16, 0.5/16) = (0.03125, 0.03125).
 *   4. The first stride-16 anchors land on the expected (0, 0) cell
 *      centre of (0.5/8, 0.5/8) = (0.0625, 0.0625).
 *   5. `face_blazeface_decode` filters anchors by post-sigmoid
 *      threshold, scales bbox coordinates back into the source-pixel
 *      space, and returns -ENOSPC on output overflow.
 */

#include "face/face.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int approx_eq(float a, float b, float tol) {
    return fabsf(a - b) <= tol;
}

static int test_anchor_table(void) {
    int failures = 0;

    face_blazeface_anchor *anchors =
        (face_blazeface_anchor *)calloc(FACE_DETECTOR_ANCHOR_COUNT,
                                        sizeof(face_blazeface_anchor));
    if (!anchors) return 1;

    int n = face_blazeface_make_anchors(anchors, FACE_DETECTOR_ANCHOR_COUNT);
    if (n != FACE_DETECTOR_ANCHOR_COUNT) {
        fprintf(stderr, "[face-anchor] anchor count: got %d expected %d\n",
                n, FACE_DETECTOR_ANCHOR_COUNT);
        ++failures;
    }

    /* All centres in [0, 1] and (w, h) == 1. */
    for (int i = 0; i < n; ++i) {
        const face_blazeface_anchor *a = &anchors[i];
        if (a->x_center < 0.0f || a->x_center > 1.0f ||
            a->y_center < 0.0f || a->y_center > 1.0f) {
            fprintf(stderr,
                    "[face-anchor] anchor[%d] centre out of [0,1]: (%f,%f)\n",
                    i, a->x_center, a->y_center);
            ++failures;
            break;
        }
        if (!approx_eq(a->w, 1.0f, 1e-6f) || !approx_eq(a->h, 1.0f, 1e-6f)) {
            fprintf(stderr,
                    "[face-anchor] anchor[%d] (w,h) not 1: (%f,%f)\n",
                    i, a->w, a->h);
            ++failures;
            break;
        }
    }

    /* First stride-8 anchor pair sits at cell (0,0): centre = 0.5/16. */
    const float c8 = 0.5f / 16.0f;
    if (!approx_eq(anchors[0].x_center, c8, 1e-6f) ||
        !approx_eq(anchors[0].y_center, c8, 1e-6f)) {
        fprintf(stderr,
                "[face-anchor] anchor[0] expected (%f,%f) got (%f,%f)\n",
                c8, c8, anchors[0].x_center, anchors[0].y_center);
        ++failures;
    }
    if (!approx_eq(anchors[1].x_center, c8, 1e-6f) ||
        !approx_eq(anchors[1].y_center, c8, 1e-6f)) {
        fprintf(stderr,
                "[face-anchor] anchor[1] expected (%f,%f) got (%f,%f)\n",
                c8, c8, anchors[1].x_center, anchors[1].y_center);
        ++failures;
    }

    /* First stride-16 anchor sextuple sits after 16*16*2 = 512 anchors,
     * cell (0,0): centre = 0.5/8 = 0.0625. */
    const float c16 = 0.5f / 8.0f;
    if (!approx_eq(anchors[512].x_center, c16, 1e-6f) ||
        !approx_eq(anchors[512].y_center, c16, 1e-6f)) {
        fprintf(stderr,
                "[face-anchor] anchor[512] expected (%f,%f) got (%f,%f)\n",
                c16, c16, anchors[512].x_center, anchors[512].y_center);
        ++failures;
    }

    /* Last anchor must be the final entry of the (7,7) cell of the
     * stride-16 layer, i.e. centre = 7.5/8 = 0.9375. */
    const float c16_last = 7.5f / 8.0f;
    if (!approx_eq(anchors[FACE_DETECTOR_ANCHOR_COUNT - 1].x_center,
                   c16_last, 1e-6f) ||
        !approx_eq(anchors[FACE_DETECTOR_ANCHOR_COUNT - 1].y_center,
                   c16_last, 1e-6f)) {
        fprintf(stderr,
                "[face-anchor] anchor[last] expected (%f,%f) got (%f,%f)\n",
                c16_last, c16_last,
                anchors[FACE_DETECTOR_ANCHOR_COUNT - 1].x_center,
                anchors[FACE_DETECTOR_ANCHOR_COUNT - 1].y_center);
        ++failures;
    }

    free(anchors);
    return failures;
}

static int test_decode(void) {
    int failures = 0;

    face_blazeface_anchor *anchors =
        (face_blazeface_anchor *)calloc(FACE_DETECTOR_ANCHOR_COUNT,
                                        sizeof(face_blazeface_anchor));
    float *regressors =
        (float *)calloc((size_t)FACE_DETECTOR_ANCHOR_COUNT * 16, sizeof(float));
    float *scores =
        (float *)calloc((size_t)FACE_DETECTOR_ANCHOR_COUNT, sizeof(float));
    if (!anchors || !regressors || !scores) {
        free(anchors); free(regressors); free(scores);
        return 1;
    }
    face_blazeface_make_anchors(anchors, FACE_DETECTOR_ANCHOR_COUNT);

    /* Default all scores to deeply-negative logits so only the anchors
     * we set are above threshold. (sigmoid(0) = 0.5 ≥ 0.5 would
     * otherwise admit every anchor.) */
    for (int i = 0; i < FACE_DETECTOR_ANCHOR_COUNT; ++i) {
        scores[i] = -20.0f;
    }

    /* Construct a single high-confidence anchor at index 100 with a
     * 32-pixel bbox centred on its anchor. Use logit ~6 for confident
     * sigmoid (~0.9975). */
    const int idx = 100;
    scores[idx] = 6.0f;
    regressors[idx * 16 + 0] = 0.0f;   /* dx */
    regressors[idx * 16 + 1] = 0.0f;   /* dy */
    regressors[idx * 16 + 2] = 32.0f;  /* w in input pixels */
    regressors[idx * 16 + 3] = 32.0f;  /* h in input pixels */
    /* Keypoints all at anchor centre. */
    for (int kp = 0; kp < FACE_DETECTOR_KEYPOINT_COUNT; ++kp) {
        regressors[idx * 16 + 4 + kp * 2 + 0] = 0.0f;
        regressors[idx * 16 + 4 + kp * 2 + 1] = 0.0f;
    }

    face_detection dets[8];
    size_t count = 0;
    /* Source image is 256x256, twice the input size. */
    int rc = face_blazeface_decode(anchors, regressors, scores,
                                   0.5f, 256, 256,
                                   dets, 8, &count);
    if (rc != 0) {
        fprintf(stderr, "[face-decode] expected 0, got %d\n", rc);
        ++failures;
    }
    if (count != 1) {
        fprintf(stderr, "[face-decode] expected 1 detection, got %zu\n", count);
        ++failures;
    }
    if (count == 1) {
        /* bbox w/h: 32 / 128 * 256 = 64 pixels in source space. */
        if (!approx_eq(dets[0].w, 64.0f, 1e-3f) ||
            !approx_eq(dets[0].h, 64.0f, 1e-3f)) {
            fprintf(stderr, "[face-decode] bbox size: got (%f,%f) expected ~64\n",
                    dets[0].w, dets[0].h);
            ++failures;
        }
        if (dets[0].confidence < 0.99f || dets[0].confidence > 1.0f) {
            fprintf(stderr, "[face-decode] confidence out of range: %f\n",
                    dets[0].confidence);
            ++failures;
        }
    }

    /* Threshold above the only confident anchor → zero detections. */
    rc = face_blazeface_decode(anchors, regressors, scores,
                               0.999999f, 256, 256,
                               dets, 8, &count);
    if (rc != 0 || count != 0) {
        fprintf(stderr,
                "[face-decode] high-threshold pass: rc=%d count=%zu (expected 0,0)\n",
                rc, count);
        ++failures;
    }

    /* Reset threshold expectations: keep the original confident anchor
     * at idx and add three more confident anchors (indices 0, 1, 2)
     * with non-zero bbox sizes. Then request a 1-slot buffer →
     * -ENOSPC, with `count` carrying the required size (>=2). */
    scores[idx] = 6.0f;
    for (int i = 0; i < 4; ++i) {
        scores[i] = 6.0f;
        regressors[i * 16 + 2] = 16.0f;
        regressors[i * 16 + 3] = 16.0f;
    }
    rc = face_blazeface_decode(anchors, regressors, scores,
                               0.5f, 256, 256,
                               dets, 1, &count);
    if (rc != -ENOSPC) {
        fprintf(stderr, "[face-decode] overflow rc: got %d expected %d\n",
                rc, -ENOSPC);
        ++failures;
    }
    if (count <= 1) {
        fprintf(stderr,
                "[face-decode] overflow count should report needed size, got %zu\n",
                count);
        ++failures;
    }

    free(anchors); free(regressors); free(scores);
    return failures;
}

int main(void) {
    int failures = 0;
    failures += test_anchor_table();
    failures += test_decode();
    printf("[face-anchor-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
