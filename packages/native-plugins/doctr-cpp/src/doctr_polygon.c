/*
 * DBNet postprocess for doctr-cpp Phase 2.
 *
 * The detector emits a probability map of the same spatial size as
 * the letterbox canvas (1024x1024 for db_resnet50). We:
 *   1. binarize at bin_thresh=0.3
 *   2. run a 4-connected connected-components labelling
 *   3. for each component, compute its axis-aligned bbox + mean
 *      probability inside that bbox
 *   4. drop components below box_thresh / min_area
 *   5. unscale from letterbox canvas back to source-image coords
 *
 * doctr's original postprocess uses Vatti polygon offsetting via
 * pyclipper to dilate the contour before bboxing. For Phase 2 we use
 * the simpler "axis-aligned bbox of the binary component" path —
 * this is what `bin_thresh` in doctr's reference postprocess
 * produces when shrunk-rectangle dilation is disabled. The oriented-
 * polygon path is a Phase 3 addition.
 *
 * No external deps (no OpenCV, no pyclipper). Plain C and one
 * stack-array breadth-first labeller.
 */

#include "doctr_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* Tuneable thresholds. Match doctr defaults. */
static const float kBinThresh = 0.3f;
static const float kBoxThresh = 0.1f;
static const int   kMinArea   = 4;
static const int   kMinSide   = 2;   /* drop bboxes that are 1px tall/wide — usually noise */

typedef struct {
    int xmin, ymin, xmax, ymax;
    float prob_sum;
    int   n_pixels;
} cc_t;

/* Push (x,y) into the BFS queue. */
static inline void bfs_push(int *qx, int *qy, int *tail, int x, int y) {
    qx[*tail] = x; qy[*tail] = y; (*tail)++;
}

size_t doctr_dbnet_postprocess(
    const float *mask, int mask_h, int mask_w,
    int src_w, int src_h, int scaled_w, int scaled_h, int target_size,
    doctr_detection *out, size_t max_detections,
    size_t *n_total)
{
    if (n_total) *n_total = 0;
    if (!mask || mask_h <= 0 || mask_w <= 0 || target_size <= 0) return 0;

    const int n = mask_h * mask_w;
    /* Two parallel int arrays: visited (0/1) and the BFS queue. The
     * worst-case queue size is n. We allocate once. */
    uint8_t *visited = (uint8_t *)calloc(n, 1);
    int *qx = (int *)malloc(sizeof(int) * n);
    int *qy = (int *)malloc(sizeof(int) * n);
    if (!visited || !qx || !qy) {
        free(visited); free(qx); free(qy);
        return 0;
    }

    /* Mask coords are in the *detector input* canvas (target_size x
     * target_size). To reverse to source coords:
     *   src_x = mask_x * (target_size / mask_w) * (src_w / scaled_w)
     * since the letterboxed scaled-image bbox sits at (0,0) and
     * occupies (scaled_w x scaled_h) inside the canvas. The mask
     * resolution equals the canvas resolution for the doctr db_resnet50
     * head (the head upsamples back to input size). When mask is
     * smaller (some training configs), we account for that with
     * mask-to-canvas scaling. */
    const float canvas_per_mask_x = (float)target_size / (float)mask_w;
    const float canvas_per_mask_y = (float)target_size / (float)mask_h;
    const float src_per_canvas_x  = (float)src_w / (float)scaled_w;
    const float src_per_canvas_y  = (float)src_h / (float)scaled_h;

    /* The bbox-emit cap. */
    cc_t *components = NULL;
    size_t n_components = 0;
    size_t cap_components = 0;

    for (int y = 0; y < mask_h; ++y) {
        for (int x = 0; x < mask_w; ++x) {
            int idx = y * mask_w + x;
            if (visited[idx]) continue;
            if (mask[idx] < kBinThresh) { visited[idx] = 1; continue; }
            /* BFS this component. */
            int head = 0, tail = 0;
            bfs_push(qx, qy, &tail, x, y);
            visited[idx] = 1;
            cc_t cc = { .xmin = x, .ymin = y, .xmax = x, .ymax = y,
                        .prob_sum = 0.0f, .n_pixels = 0 };
            while (head < tail) {
                int cx = qx[head], cy = qy[head]; ++head;
                int ci = cy * mask_w + cx;
                cc.prob_sum += mask[ci];
                cc.n_pixels++;
                if (cx < cc.xmin) cc.xmin = cx;
                if (cx > cc.xmax) cc.xmax = cx;
                if (cy < cc.ymin) cc.ymin = cy;
                if (cy > cc.ymax) cc.ymax = cy;
                static const int dx[4] = { 1, -1, 0, 0 };
                static const int dy[4] = { 0, 0, 1, -1 };
                for (int k = 0; k < 4; ++k) {
                    int nx = cx + dx[k], ny = cy + dy[k];
                    if (nx < 0 || nx >= mask_w || ny < 0 || ny >= mask_h) continue;
                    int ni = ny * mask_w + nx;
                    if (visited[ni]) continue;
                    if (mask[ni] < kBinThresh) { visited[ni] = 1; continue; }
                    visited[ni] = 1;
                    bfs_push(qx, qy, &tail, nx, ny);
                }
            }
            /* Filter. */
            if (cc.n_pixels < kMinArea) continue;
            float mean_prob = cc.prob_sum / (float)cc.n_pixels;
            if (mean_prob < kBoxThresh) continue;
            int w_box = cc.xmax - cc.xmin + 1;
            int h_box = cc.ymax - cc.ymin + 1;
            if (w_box < kMinSide || h_box < kMinSide) continue;
            /* Append. */
            if (n_components == cap_components) {
                size_t newc = cap_components ? cap_components * 2 : 16;
                cc_t *nb = (cc_t *)realloc(components, sizeof(cc_t) * newc);
                if (!nb) goto out_cleanup;
                components = nb;
                cap_components = newc;
            }
            components[n_components++] = cc;
        }
    }

    if (n_total) *n_total = n_components;

    size_t emit = n_components < max_detections ? n_components : max_detections;
    for (size_t i = 0; i < emit; ++i) {
        cc_t *cc = &components[i];
        /* Convert mask coords -> canvas coords -> source coords. */
        float canv_xmin = (float)cc->xmin * canvas_per_mask_x;
        float canv_ymin = (float)cc->ymin * canvas_per_mask_y;
        float canv_xmax = (float)(cc->xmax + 1) * canvas_per_mask_x;
        float canv_ymax = (float)(cc->ymax + 1) * canvas_per_mask_y;
        float src_xmin = canv_xmin * src_per_canvas_x;
        float src_ymin = canv_ymin * src_per_canvas_y;
        float src_xmax = canv_xmax * src_per_canvas_x;
        float src_ymax = canv_ymax * src_per_canvas_y;
        int ix = (int)floorf(src_xmin);
        int iy = (int)floorf(src_ymin);
        int iw = (int)ceilf(src_xmax) - ix;
        int ih = (int)ceilf(src_ymax) - iy;
        if (ix < 0) { iw += ix; ix = 0; }
        if (iy < 0) { ih += iy; iy = 0; }
        if (ix + iw > src_w) iw = src_w - ix;
        if (iy + ih > src_h) ih = src_h - iy;
        if (iw < 1) iw = 1;
        if (ih < 1) ih = 1;
        out[i].bbox.x = ix;
        out[i].bbox.y = iy;
        out[i].bbox.width  = iw;
        out[i].bbox.height = ih;
        out[i].confidence = cc->prob_sum / (float)cc->n_pixels;
    }

out_cleanup:
    free(components);
    free(visited);
    free(qx);
    free(qy);
    return emit;
}
