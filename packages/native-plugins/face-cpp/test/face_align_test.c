/*
 * Behavioural test for `face_align_5pt`.
 *
 * Strategy: build a synthetic source image whose face landmarks are
 * the identity-transform inverse of the canonical 112x112 reference
 * points (insightface arcface_dst). After alignment, the warped
 * 112x112 output should reproduce the same RGB pattern at each
 * reference-point location.
 *
 * We populate the source image with a deterministic colour gradient,
 * then check that the values sampled at the reference keypoint
 * locations in the *output* match the values at the corresponding
 * source keypoints in the *input* (within bilinear-rounding
 * tolerance).
 */

#include "face/face.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SRC_W 224
#define SRC_H 224
#define CROP  FACE_EMBED_CROP_SIZE   /* 112 */

static uint8_t pat(int x, int y, int channel) {
    /* Deterministic-but-varied pattern; avoids constant or wrap-aliased
     * regions where bilinear could fool the test. */
    const int v = (x * 3 + y * 5 + channel * 17) & 0xFF;
    return (uint8_t)v;
}

int main(void) {
    /* Source image. */
    uint8_t *src = (uint8_t *)malloc((size_t)SRC_W * SRC_H * 3);
    if (!src) return 1;
    for (int y = 0; y < SRC_H; ++y) {
        for (int x = 0; x < SRC_W; ++x) {
            uint8_t *p = src + (size_t)(y * SRC_W + x) * 3u;
            p[0] = pat(x, y, 0);
            p[1] = pat(x, y, 1);
            p[2] = pat(x, y, 2);
        }
    }

    /* Build a face_detection whose 6 BlazeFace landmarks place the 5
     * alignment keypoints at the centre of the source image, scaled
     * by 1.0 (i.e. the warp's similarity should be the identity-shift
     * that maps the canonical 112x112 reference rectangle to the
     * matching region of the source image).
     *
     * Canonical 112x112 dst: insightface arcface_dst. We translate
     * those by (offset, offset) into the source image and check that
     * the alignment recovers the originals. */
    const float offset_x = ((float)SRC_W - (float)CROP) * 0.5f;
    const float offset_y = ((float)SRC_H - (float)CROP) * 0.5f;

    const float DST[5][2] = {
        { 38.2946f, 51.6963f },
        { 73.5318f, 51.5014f },
        { 56.0252f, 71.7366f },
        { 41.5493f, 92.3655f },
        { 70.7299f, 92.2041f },
    };

    /* The aligner takes 6 BlazeFace landmarks (eye L/R, nose, mouth
     * centre, ear L/R) and synthesizes mouth corners along the
     * eye-axis. To make the synthesized mouth corners coincide with
     * the canonical mouth-left / mouth-right reference, place the
     * mouth centre at the midpoint of the canonical mouth corners and
     * align the eye axis along the +x direction (which it already is,
     * since both eyes share the same y in the reference set). */
    face_detection det = {0};
    /* Bbox is unused by face_align_5pt — landmarks alone drive the
     * affine. Use sentinel values. */
    det.x = 0; det.y = 0; det.w = SRC_W; det.h = SRC_H; det.confidence = 1.0f;

    det.landmarks[0] = DST[0][0] + offset_x;  /* left eye */
    det.landmarks[1] = DST[0][1] + offset_y;
    det.landmarks[2] = DST[1][0] + offset_x;  /* right eye */
    det.landmarks[3] = DST[1][1] + offset_y;
    det.landmarks[4] = DST[2][0] + offset_x;  /* nose tip */
    det.landmarks[5] = DST[2][1] + offset_y;

    /* Mouth centre = midpoint of canonical mouth-left / mouth-right.
     * The aligner will then synthesize mouth corners as
     *   centre +/- 0.40 * eye_distance * eye_axis
     * Set the synthesized corners to coincide with the canonical
     * mouth-left/right by adjusting our half-width assumption: the
     * test simply checks the warp recovers an identity offset, so
     * tolerate a few pixels of bilinear smear via a wider tolerance
     * around the mouth points. */
    const float mouth_cx = 0.5f * (DST[3][0] + DST[4][0]) + offset_x;
    const float mouth_cy = 0.5f * (DST[3][1] + DST[4][1]) + offset_y;
    det.landmarks[6] = mouth_cx;
    det.landmarks[7] = mouth_cy;
    /* Ear tragion landmarks unused by 5-pt alignment; set sentinel. */
    det.landmarks[8] = 0.0f;
    det.landmarks[9] = 0.0f;
    det.landmarks[10] = 0.0f;
    det.landmarks[11] = 0.0f;

    uint8_t *out = (uint8_t *)malloc((size_t)CROP * CROP * 3);
    if (!out) { free(src); return 1; }

    int rc = face_align_5pt(src, SRC_W, SRC_H, SRC_W * 3, &det, out);
    if (rc != 0) {
        fprintf(stderr, "[face-align] face_align_5pt rc=%d\n", rc);
        free(src); free(out);
        return 1;
    }

    /* Spot-check the canonical reference points. The eyes and nose
     * should match exactly (within bilinear rounding); the mouth
     * corners are synthesized, so allow a wider tolerance since the
     * synthesized half-width is heuristic. */
    int failures = 0;
    const int tight_tol = 4;   /* bilinear smear + similarity rounding */
    const int loose_tol = 24;  /* mouth-corner synthesis heuristic */
    const int tols[5] = { tight_tol, tight_tol, tight_tol, loose_tol, loose_tol };

    for (int i = 0; i < 5; ++i) {
        const int ox = (int)(DST[i][0] + 0.5f);
        const int oy = (int)(DST[i][1] + 0.5f);
        const int sx = ox + (int)(offset_x + 0.5f);
        const int sy = oy + (int)(offset_y + 0.5f);

        for (int ch = 0; ch < 3; ++ch) {
            const uint8_t got = out[(size_t)(oy * CROP + ox) * 3u + (size_t)ch];
            const uint8_t want = pat(sx, sy, ch);
            const int diff = (int)got - (int)want;
            const int adiff = diff < 0 ? -diff : diff;
            if (adiff > tols[i]) {
                fprintf(stderr,
                        "[face-align] kp %d ch %d: got %u expected %u (tol %d)\n",
                        i, ch, got, want, tols[i]);
                ++failures;
                break;
            }
        }
    }

    free(src); free(out);
    printf("[face-align-test] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
