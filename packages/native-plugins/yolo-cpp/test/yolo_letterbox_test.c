/*
 * Behavioural test for yolo_letterbox_rgb_to_chw.
 *
 * Two cases cover the contract:
 *
 *  A. A square (640×640) all-white image. Letterbox-with-pad-zero is a
 *     no-op resize at scale 1.0; the entire output plane should be
 *     1.0 (255/255), with zero-pad on no edge. Verifies the
 *     no-rescale identity path and the [0,1] normalization.
 *
 *  B. A wider-than-tall (1280×320) image with a black left half and
 *     white right half. Letterbox to 640×640 → scale 0.5, padding
 *     (640 - 160) / 2 = 240 rows top + bottom. The padded rows must
 *     hold the neutral grey 114/255 ≈ 0.447, the central 160 rows must
 *     contain the resized content (left half ≈ 0.0, right half ≈ 1.0),
 *     and the reported scale + pads must agree.
 *
 *  Edge sample tolerances are loose (1e-2) because bilinear resampling
 *  introduces small interpolation noise at content boundaries.
 */

#include "yolo/yolo.h"
#include "../src/yolo_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPECT(cond, msg)                                              \
    do {                                                                \
        if (!(cond)) {                                                  \
            fprintf(stderr, "[yolo-letterbox] FAIL %s:%d %s\n",        \
                    __FILE__, __LINE__, msg);                          \
            ++failures;                                                 \
        }                                                               \
    } while (0)

static int near(float a, float b, float tol) {
    return fabsf(a - b) < tol;
}

int main(void) {
    int failures = 0;
    const int target = 640;
    float *chw = (float *)malloc(sizeof(float) * 3 * target * target);
    if (!chw) {
        fprintf(stderr, "[yolo-letterbox] OOM\n");
        return 1;
    }

    /* ── A: 640×640 all-white identity ───────────────────────────── */
    {
        const int sz = 640;
        uint8_t *src = (uint8_t *)malloc((size_t)sz * sz * 3);
        memset(src, 255, (size_t)sz * sz * 3);
        yolo_image img = { .rgb = src, .w = sz, .h = sz, .stride = sz * 3 };
        float scale = 0.0f; int pw = -1, ph = -1;
        int rc = yolo_letterbox_rgb_to_chw(&img, target, chw, &scale, &pw, &ph);
        EXPECT(rc == 0, "case A: rc==0");
        EXPECT(near(scale, 1.0f, 1e-4f), "case A: scale==1");
        EXPECT(pw == 0 && ph == 0, "case A: zero pad");

        /* Spot-check center pixel: should be ~1.0 in all 3 channels. */
        const int hw = target * target;
        for (int c = 0; c < 3; ++c) {
            float v = chw[(size_t)c * hw + (size_t)320 * target + 320];
            EXPECT(near(v, 1.0f, 1e-3f), "case A: center is white");
        }
        free(src);
    }

    /* ── B: 1280×320 split black/white, letterbox to 640×640 ────── */
    {
        const int W = 1280, H = 320;
        uint8_t *src = (uint8_t *)malloc((size_t)W * H * 3);
        for (int y = 0; y < H; ++y) {
            for (int x = 0; x < W; ++x) {
                uint8_t v = (x < W / 2) ? 0 : 255;
                src[((size_t)y * W + x) * 3 + 0] = v;
                src[((size_t)y * W + x) * 3 + 1] = v;
                src[((size_t)y * W + x) * 3 + 2] = v;
            }
        }
        yolo_image img = { .rgb = src, .w = W, .h = H, .stride = W * 3 };
        float scale = 0.0f; int pw = -1, ph = -1;
        int rc = yolo_letterbox_rgb_to_chw(&img, target, chw, &scale, &pw, &ph);
        EXPECT(rc == 0, "case B: rc==0");
        EXPECT(near(scale, 0.5f, 1e-4f), "case B: scale==0.5");
        EXPECT(pw == 0,  "case B: pad_w==0 (long edge fits)");
        EXPECT(ph == 240, "case B: pad_h==240 (vertical center pad)");

        const int hw = target * target;
        /* Top padded row → neutral grey 114/255. */
        const float neutral = 114.0f / 255.0f;
        float top = chw[(size_t)0 * hw + (size_t)10 * target + 320];
        EXPECT(near(top, neutral, 1e-3f), "case B: pad top is neutral grey");

        /* Center-left should sit inside the resized black half (≈0). */
        float center_left = chw[(size_t)0 * hw + (size_t)320 * target + 100];
        EXPECT(center_left < 0.05f, "case B: resized left half is black");

        /* Center-right should sit inside the resized white half (≈1). */
        float center_right = chw[(size_t)0 * hw + (size_t)320 * target + 540];
        EXPECT(center_right > 0.95f, "case B: resized right half is white");

        /* Bottom padded row → neutral grey too. */
        float bottom = chw[(size_t)0 * hw + (size_t)630 * target + 320];
        EXPECT(near(bottom, neutral, 1e-3f), "case B: pad bottom is neutral grey");

        free(src);
    }

    /* ── EINVAL on bad input ─────────────────────────────────────── */
    {
        int rc = yolo_letterbox_rgb_to_chw(NULL, target, chw, NULL, NULL, NULL);
        EXPECT(rc < 0, "NULL image rejected");
    }

    free(chw);
    printf("[yolo-letterbox] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
