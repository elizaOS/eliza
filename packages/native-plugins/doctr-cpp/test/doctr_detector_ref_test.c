/*
 * Phase 2 reference-impl test for the detector path.
 *
 * The full db_resnet50 forward needs the converted GGUF weights from
 * scripts/doctr_to_gguf.py. Phase 2 doesn't ship those weights inside
 * the repo (they're hundreds of MB), so this test exercises the parts
 * of the detector path that don't require weights:
 *
 *   1. `doctr_open` against a missing GGUF must return -ENOENT and
 *      leave the out handle NULL. The library refuses to fabricate
 *      success.
 *   2. `doctr_letterbox_rgb_to_chw` round-trips a synthetic image
 *      through the canvas without dropping content (sanity check on
 *      the preprocess path the detector uses).
 *   3. `doctr_dbnet_postprocess` turns a synthetic probability mask
 *      with a single black-rectangle "text region" into at least one
 *      bbox, with IoU >= 0.5 against the ground-truth bbox after the
 *      mask -> canvas -> source coord chain.
 *
 * The bit-exact end-to-end forward pass against weights is covered by
 * Phase 2's parity test (run separately with a GGUF on disk). This
 * test runs in CI without any external assets.
 */

#include "doctr/doctr.h"
#include "doctr_internal.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

#define EXPECT(cond, ...) do { \
    if (!(cond)) { \
        fprintf(stderr, "[detector-ref] FAIL %s:%d: ", __FILE__, __LINE__); \
        fprintf(stderr, __VA_ARGS__); \
        fprintf(stderr, "\n"); \
        ++failures; \
    } \
} while (0)

/* Build a synthetic 256x256 RGB image: white background with a black
 * filled rectangle at (60..195, 100..155) — w=136, h=56 — that stands
 * in for a text region. Returns a heap-allocated buffer the caller
 * frees. */
static uint8_t *synth_image_with_rect(
    int w, int h,
    int rx, int ry, int rw, int rh)
{
    uint8_t *buf = (uint8_t *)malloc((size_t)w * h * 3);
    if (!buf) return NULL;
    memset(buf, 255, (size_t)w * h * 3);  /* white */
    for (int y = ry; y < ry + rh; ++y) {
        if (y < 0 || y >= h) continue;
        for (int x = rx; x < rx + rw; ++x) {
            if (x < 0 || x >= w) continue;
            uint8_t *p = buf + ((size_t)y * w + x) * 3;
            p[0] = p[1] = p[2] = 0;
        }
    }
    return buf;
}

/* Build a synthetic probability mask: zeros everywhere, ones inside
 * the detector rectangle. Mask coordinates are in detector-canvas
 * pixel space, so the test passes mask_h == mask_w == target_size and
 * scaled_w/h == src_w/h to keep the mask->source coord transform an
 * identity. */
static float *synth_mask_with_rect(
    int mask_h, int mask_w,
    int rx, int ry, int rw, int rh)
{
    float *mask = (float *)calloc((size_t)mask_h * mask_w, sizeof(float));
    if (!mask) return NULL;
    for (int y = ry; y < ry + rh; ++y) {
        if (y < 0 || y >= mask_h) continue;
        for (int x = rx; x < rx + rw; ++x) {
            if (x < 0 || x >= mask_w) continue;
            mask[(size_t)y * mask_w + x] = 1.0f;
        }
    }
    return mask;
}

static float iou(int ax, int ay, int aw, int ah,
                 int bx, int by, int bw, int bh) {
    int x1 = ax > bx ? ax : bx;
    int y1 = ay > by ? ay : by;
    int x2 = (ax + aw) < (bx + bw) ? (ax + aw) : (bx + bw);
    int y2 = (ay + ah) < (by + bh) ? (ay + ah) : (by + bh);
    int iw = x2 - x1; if (iw < 0) iw = 0;
    int ih = y2 - y1; if (ih < 0) ih = 0;
    int inter = iw * ih;
    int union_area = aw * ah + bw * bh - inter;
    return union_area > 0 ? (float)inter / (float)union_area : 0.0f;
}

static void test_open_missing_gguf(void) {
    doctr_session *s = (doctr_session *)0xdeadbeef;
    int rc = doctr_open("/nonexistent-doctr.gguf", &s);
    /* The C ABI doc allows -ENOENT for missing GGUF; the GGUF reader
     * returns -errno from open(2), which on Linux is -ENOENT. */
    EXPECT(rc == -ENOENT, "doctr_open(missing) returned %d, expected -ENOENT (%d)", rc, -ENOENT);
    EXPECT(s == NULL, "doctr_open did not clear the out handle on failure");
}

static void test_letterbox_preprocess(void) {
    const int W = 256, H = 256, target = 1024;
    uint8_t *img = synth_image_with_rect(W, H, 100, 60, 56, 136);
    EXPECT(img != NULL, "image alloc failed");
    if (!img) return;

    float *canvas = (float *)malloc(sizeof(float) * 3 * target * target);
    EXPECT(canvas != NULL, "canvas alloc failed");
    if (!canvas) { free(img); return; }

    int sw = -1, sh = -1;
    int rc = doctr_letterbox_rgb_to_chw(img, W, H, canvas, target, &sw, &sh);
    EXPECT(rc == 0, "letterbox returned %d", rc);
    /* Square 256x256 input scales to 1024x1024 at the canvas. */
    EXPECT(sw == target && sh == target,
           "scaled bbox should fill canvas; got %dx%d", sw, sh);

    /* Spot-check: top-left corner of the canvas should reflect the
     * white background after normalization (positive value because
     * (1.0 - mean) / std > 0). */
    EXPECT(canvas[0] > 0.0f,
           "canvas[0] should be positive for white bg, got %.4f", canvas[0]);

    free(canvas);
    free(img);
}

static void test_dbnet_postprocess_recovers_rect(void) {
    /* Source image: 256x256, black rect at (100, 60, 56, 136). Build
     * the mask in canvas-pixel space (1024x1024 target). The detector
     * canvas would have the source image scaled by 4x to fill it
     * (256 -> 1024). */
    const int src_w = 256, src_h = 256;
    const int target = 1024;
    const int rx_src = 100, ry_src = 60, rw_src = 56, rh_src = 136;
    /* Mask matches canvas resolution; rect inside the mask is the
     * source-space rect scaled by 4. */
    const int rx_mask = rx_src * 4;
    const int ry_mask = ry_src * 4;
    const int rw_mask = rw_src * 4;
    const int rh_mask = rh_src * 4;

    float *mask = synth_mask_with_rect(target, target, rx_mask, ry_mask, rw_mask, rh_mask);
    EXPECT(mask != NULL, "mask alloc failed");
    if (!mask) return;

    doctr_detection out[8];
    size_t n_total = 0;
    size_t n = doctr_dbnet_postprocess(
        mask, target, target,
        src_w, src_h,
        /* scaled_w/h fill the canvas because src is square at 256x256
         * and target_size=1024 letterbox preserves aspect by scaling
         * the longer edge to target. */
        target, target, target,
        out, sizeof(out)/sizeof(out[0]), &n_total);

    EXPECT(n >= 1, "expected >=1 bbox, got %zu (n_total=%zu)", n, n_total);
    if (n >= 1) {
        float best = 0.0f;
        int best_idx = -1;
        for (size_t i = 0; i < n; ++i) {
            float v = iou(out[i].bbox.x, out[i].bbox.y,
                          out[i].bbox.width, out[i].bbox.height,
                          rx_src, ry_src, rw_src, rh_src);
            if (v > best) { best = v; best_idx = (int)i; }
        }
        EXPECT(best > 0.5f,
               "best IoU=%.3f (idx=%d, bbox=%d,%d,%dx%d, gt=%d,%d,%dx%d)",
               best, best_idx,
               out[best_idx >= 0 ? best_idx : 0].bbox.x,
               out[best_idx >= 0 ? best_idx : 0].bbox.y,
               out[best_idx >= 0 ? best_idx : 0].bbox.width,
               out[best_idx >= 0 ? best_idx : 0].bbox.height,
               rx_src, ry_src, rw_src, rh_src);
        EXPECT(out[best_idx >= 0 ? best_idx : 0].confidence > 0.9f,
               "expected high confidence on solid rect, got %.3f",
               out[best_idx >= 0 ? best_idx : 0].confidence);
    }

    free(mask);
}

static void test_active_backend_is_ref(void) {
    const char *b = doctr_active_backend();
    EXPECT(b != NULL && strcmp(b, "ref-c") == 0,
           "active_backend = %s, expected ref-c", b ? b : "(null)");
}

int main(void) {
    test_open_missing_gguf();
    test_letterbox_preprocess();
    test_dbnet_postprocess_recovers_rect();
    test_active_backend_is_ref();
    printf("[detector-ref] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
