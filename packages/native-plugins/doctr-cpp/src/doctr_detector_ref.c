/*
 * db_resnet50 forward pass — pure-C reference.
 *
 * Architecture (from python-doctr 1.0.1 db_resnet50, verified against
 * the state_dict shipped with the pretrained checkpoint):
 *
 *   stem:
 *     conv1: Conv2d(3, 64, 7, stride=2, padding=3)
 *     bn1:   BatchNorm2d(64), ReLU
 *     maxpool: MaxPool2d(3, stride=2, padding=1)
 *
 *   layer1 (3 bottleneck blocks, stride 1, channels 64->256):
 *     each block:
 *       conv1: 1x1 in -> mid (64)
 *       conv2: 3x3 mid -> mid stride 1
 *       conv3: 1x1 mid -> 256
 *       (block 0 has a 1x1 downsample)
 *
 *   layer2 (4 blocks, first stride 2, channels 256->512):
 *     mid=128, out=512.
 *
 *   layer3 (6 blocks, first stride 2, channels 512->1024):
 *     mid=256, out=1024.
 *
 *   layer4 (3 blocks, first stride 2, channels 1024->2048):
 *     mid=512, out=2048.
 *
 *   FPN over (layer1 out, layer2 out, layer3 out, layer4 out):
 *     in_branches[i]: 1x1 conv to 256 ch + BN
 *     top-down sum via 2x bilinear upsample
 *     out_branches[i]: 3x3 conv to 64 ch + BN
 *     concat 4 branches → 256 ch feature map at layer1's spatial size
 *
 *   prob_head:
 *     0: 3x3 conv 256 -> 64
 *     1: BN(64), ReLU
 *     3: ConvTranspose2d 64 -> 64, kernel 2, stride 2
 *     4: BN(64), ReLU
 *     6: ConvTranspose2d 64 -> 1, kernel 2, stride 2
 *     sigmoid
 *
 * The output is a fp32 probability map at canvas resolution
 * (1024x1024 by default). DBNet postprocess turns it into bboxes via
 * doctr_dbnet_postprocess().
 *
 * Phase 2 implements the full forward pass in scalar C. Phase 3 will
 * replace the Conv2D op with an im2col + AVX2/NEON GEMM dispatch. The
 * cumulative work here is on the order of a few minutes per call on a
 * modern x86 — acceptable for the ref test, far too slow for prod;
 * Phase 3 is what makes it interesting.
 */

#include "doctr_internal.h"
#include "doctr_session.h"

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const float *T(const doctr_gguf *g, const char *name,
                      int64_t *dims, int *ndim)
{
    return doctr_gguf_get_f32(g, name, dims, 4, ndim);
}

/* Conv2D + (optional) BN + (optional) ReLU helper. Allocates and
 * returns a fresh output buffer; caller frees. */
static int conv_bn_relu_fresh(
    const doctr_gguf *g,
    const char *conv_name, /* full prefix like "det.feat_extractor.conv1" */
    const char *bn_name,   /* full prefix like "det.feat_extractor.bn1" or NULL */
    bool relu,
    int strideh, int stridew, int padh, int padw,
    const float *x, int cin, int hin, int win,
    int cout_expected, int kh, int kw,
    float **out, int *hout, int *wout)
{
    char buf[256];
    int64_t dims[4]; int nd;

    snprintf(buf, sizeof buf, "%s.weight", conv_name);
    const float *w = T(g, buf, dims, &nd);
    if (!w || nd != 4 || dims[0] != cout_expected || dims[1] != cin
        || dims[2] != kh || dims[3] != kw) {
        return -EINVAL;
    }
    snprintf(buf, sizeof buf, "%s.bias", conv_name);
    const float *b = T(g, buf, dims, &nd);  /* may be missing — torchvision Resnet has no conv bias */

    const int H = (hin + 2 * padh - kh) / strideh + 1;
    const int W = (win + 2 * padw - kw) / stridew + 1;
    float *y = (float *)malloc(sizeof(float) * (size_t)cout_expected * H * W);
    if (!y) return -ENOMEM;
    doctr_conv2d_ref(x, cin, hin, win, w, cout_expected, kh, kw, b,
                     strideh, stridew, padh, padw, y);

    if (bn_name) {
        snprintf(buf, sizeof buf, "%s.weight", bn_name);
        const float *gamma = T(g, buf, dims, &nd); if (!gamma) { free(y); return -EINVAL; }
        snprintf(buf, sizeof buf, "%s.bias", bn_name);
        const float *beta  = T(g, buf, dims, &nd); if (!beta)  { free(y); return -EINVAL; }
        snprintf(buf, sizeof buf, "%s.running_mean", bn_name);
        const float *mean  = T(g, buf, dims, &nd); if (!mean)  { free(y); return -EINVAL; }
        snprintf(buf, sizeof buf, "%s.running_var", bn_name);
        const float *var   = T(g, buf, dims, &nd); if (!var)   { free(y); return -EINVAL; }
        float *scratch = (float *)malloc(sizeof(float) * (size_t)cout_expected * 2);
        if (!scratch) { free(y); return -ENOMEM; }
        float *scale = scratch;
        float *shift = scratch + cout_expected;
        doctr_bn_fold(gamma, beta, mean, var, 1e-5f, cout_expected, scale, shift);
        doctr_apply_affine_relu(y, cout_expected, H * W, scale, shift, relu);
        free(scratch);
    } else if (relu) {
        for (int i = 0; i < cout_expected * H * W; ++i) if (y[i] < 0.0f) y[i] = 0.0f;
    }

    *out = y;
    *hout = H; *wout = W;
    return 0;
}

/* Resnet bottleneck block:
 *   y = relu(bn3(conv3(relu(bn2(conv2(relu(bn1(conv1(x)))))))) + downsample(x))
 * conv1 is 1x1 ch_in -> ch_mid stride 1
 * conv2 is 3x3 ch_mid -> ch_mid stride
 * conv3 is 1x1 ch_mid -> ch_out stride 1
 * downsample (when ch_in != ch_out or stride != 1):
 *   1x1 conv ch_in -> ch_out stride
 */
static int bottleneck(
    const doctr_gguf *g, const char *block_prefix,
    int stride, int ch_in, int ch_mid, int ch_out,
    bool has_downsample,
    const float *x, int hin, int win,
    float **out, int *hout, int *wout)
{
    char nm_conv[200], nm_bn[200];
    float *t1 = NULL, *t2 = NULL, *t3 = NULL, *ds = NULL;
    int h1, w1, h2, w2, h3, w3;
    int rc;

    snprintf(nm_conv, sizeof nm_conv, "%s.conv1", block_prefix);
    snprintf(nm_bn,   sizeof nm_bn,   "%s.bn1",   block_prefix);
    rc = conv_bn_relu_fresh(g, nm_conv, nm_bn, true,
                            1, 1, 0, 0,
                            x, ch_in, hin, win, ch_mid, 1, 1,
                            &t1, &h1, &w1);
    if (rc != 0) return rc;

    snprintf(nm_conv, sizeof nm_conv, "%s.conv2", block_prefix);
    snprintf(nm_bn,   sizeof nm_bn,   "%s.bn2",   block_prefix);
    rc = conv_bn_relu_fresh(g, nm_conv, nm_bn, true,
                            stride, stride, 1, 1,
                            t1, ch_mid, h1, w1, ch_mid, 3, 3,
                            &t2, &h2, &w2);
    free(t1);
    if (rc != 0) return rc;

    snprintf(nm_conv, sizeof nm_conv, "%s.conv3", block_prefix);
    snprintf(nm_bn,   sizeof nm_bn,   "%s.bn3",   block_prefix);
    rc = conv_bn_relu_fresh(g, nm_conv, nm_bn, /* relu */ false,
                            1, 1, 0, 0,
                            t2, ch_mid, h2, w2, ch_out, 1, 1,
                            &t3, &h3, &w3);
    free(t2);
    if (rc != 0) return rc;

    if (has_downsample) {
        char dsc[200], dsb[200];
        snprintf(dsc, sizeof dsc, "%s.downsample.0", block_prefix);
        snprintf(dsb, sizeof dsb, "%s.downsample.1", block_prefix);
        int dh, dw;
        rc = conv_bn_relu_fresh(g, dsc, dsb, false,
                                stride, stride, 0, 0,
                                x, ch_in, hin, win, ch_out, 1, 1,
                                &ds, &dh, &dw);
        if (rc != 0) { free(t3); return rc; }
        if (dh != h3 || dw != w3) { free(t3); free(ds); return -EINVAL; }
    } else {
        /* Identity. Caller guarantees shapes match. */
        ds = (float *)malloc(sizeof(float) * (size_t)ch_out * h3 * w3);
        if (!ds) { free(t3); return -ENOMEM; }
        memcpy(ds, x, sizeof(float) * (size_t)ch_out * h3 * w3);
    }

    /* Sum + ReLU. */
    const int n = ch_out * h3 * w3;
    for (int i = 0; i < n; ++i) {
        float v = t3[i] + ds[i];
        t3[i] = v > 0.0f ? v : 0.0f;
    }
    free(ds);
    *out = t3; *hout = h3; *wout = w3;
    return 0;
}

/* Run a layer (sequence of bottlenecks). The first block strides; the
 * rest are stride 1. The first block always has a downsample. */
static int run_layer(
    const doctr_gguf *g, const char *layer_prefix,
    int n_blocks, int stride, int ch_in, int ch_mid, int ch_out,
    const float *x, int hin, int win,
    float **out, int *hout, int *wout)
{
    char buf[200];
    float *cur = NULL;
    int   ch = hin, cw_ = win;
    int   in_c = ch_in;

    for (int i = 0; i < n_blocks; ++i) {
        snprintf(buf, sizeof buf, "%s.%d", layer_prefix, i);
        int s = (i == 0) ? stride : 1;
        bool has_ds = (i == 0);  /* first block always has downsample */
        float *next = NULL;
        int nh, nw;
        const float *in_buf = (i == 0) ? x : cur;
        int rc = bottleneck(g, buf, s, (i == 0) ? in_c : ch_out, ch_mid, ch_out,
                            has_ds, in_buf, ch, cw_, &next, &nh, &nw);
        if (rc != 0) { free(cur); return rc; }
        free(cur);
        cur = next;
        ch = nh; cw_ = nw;
    }
    *out = cur; *hout = ch; *wout = cw_;
    return 0;
}

int doctr_detector_forward(
    doctr_session *s, const doctr_image *image,
    doctr_detection *out, size_t max_detections, size_t *out_count)
{
    if (out_count) *out_count = 0;
    if (!s || !image || !image->rgb) return -EINVAL;

    const int target = (int)s->detector_input_size;
    /* Letterbox into the canvas. */
    int scaled_w, scaled_h;
    float *x0 = (float *)malloc(sizeof(float) * 3 * (size_t)target * target);
    if (!x0) return -ENOMEM;
    int rc = doctr_letterbox_rgb_to_chw(
        image->rgb, image->width, image->height, x0, target, &scaled_w, &scaled_h);
    if (rc != 0) { free(x0); return rc; }

    /* Stem: conv1 (3->64, k=7, s=2, p=3), bn1, relu, maxpool(3, s=2, p=1). */
    float *stem = NULL;
    int hs, ws;
    rc = conv_bn_relu_fresh(
        s->gguf, "det.feat_extractor.conv1", "det.feat_extractor.bn1", true,
        2, 2, 3, 3,
        x0, 3, target, target, 64, 7, 7,
        &stem, &hs, &ws);
    free(x0);
    if (rc != 0) return rc;

    int hp = (hs + 2 * 1 - 3) / 2 + 1;
    int wp = (ws + 2 * 1 - 3) / 2 + 1;
    float *p0 = (float *)malloc(sizeof(float) * 64 * (size_t)hp * wp);
    if (!p0) { free(stem); return -ENOMEM; }
    doctr_maxpool2d_ref(stem, 64, hs, ws, 3, 3, 2, 2, 1, 1, p0);
    free(stem);

    /* layer1..4 (bottleneck channels per torchvision resnet50). */
    float *l1, *l2, *l3, *l4;
    int h1, w1, h2, w2, h3, w3, h4, w4;
    rc = run_layer(s->gguf, "det.feat_extractor.layer1", 3, 1,    64,   64,  256, p0, hp, wp, &l1, &h1, &w1);
    free(p0); if (rc != 0) return rc;
    rc = run_layer(s->gguf, "det.feat_extractor.layer2", 4, 2,   256,  128,  512, l1, h1, w1, &l2, &h2, &w2);
    if (rc != 0) { free(l1); return rc; }
    rc = run_layer(s->gguf, "det.feat_extractor.layer3", 6, 2,   512,  256, 1024, l2, h2, w2, &l3, &h3, &w3);
    if (rc != 0) { free(l1); free(l2); return rc; }
    rc = run_layer(s->gguf, "det.feat_extractor.layer4", 3, 2,  1024,  512, 2048, l3, h3, w3, &l4, &h4, &w4);
    if (rc != 0) { free(l1); free(l2); free(l3); return rc; }

    /* FPN. in_branches reduce each layer to 256 ch via 1x1 conv + BN.
     * No ReLU is applied by doctr's FPN before the top-down sum. */
    float *in_b[4] = {0};
    int   in_h[4], in_w[4];
    int   layer_chs[4] = {256, 512, 1024, 2048};
    float *layer_outs[4] = {l1, l2, l3, l4};
    int   layer_hs[4]    = {h1, h2, h3, h4};
    int   layer_ws[4]    = {w1, w2, w3, w4};
    char  buf[200];
    for (int i = 0; i < 4; ++i) {
        char conv_n[200], bn_n[200];
        snprintf(conv_n, sizeof conv_n, "det.fpn.in_branches.%d.0", i);
        snprintf(bn_n,   sizeof bn_n,   "det.fpn.in_branches.%d.1", i);
        rc = conv_bn_relu_fresh(s->gguf, conv_n, bn_n, false,
                                1, 1, 0, 0,
                                layer_outs[i], layer_chs[i], layer_hs[i], layer_ws[i],
                                256, 1, 1, &in_b[i], &in_h[i], &in_w[i]);
        free(layer_outs[i]);
        if (rc != 0) goto fpn_fail;
    }

    /* Top-down: in_b[3] is the deepest. We upsample it ×2 and add to in_b[2], etc.
     * Doctr sums then up-samples. The exact merge formula:
     *   p4 = in_b[3]
     *   p3 = in_b[2] + up2(p4)
     *   p2 = in_b[1] + up2(p3)
     *   p1 = in_b[0] + up2(p2)
     */
    float *p[4] = {0};
    p[3] = in_b[3]; in_b[3] = NULL;
    for (int k = 2; k >= 0; --k) {
        /* Upsample p[k+1] from (256, in_h[k+1], in_w[k+1]) to (256, in_h[k], in_w[k]). */
        int factor_h = in_h[k] / in_h[k+1];
        int factor_w = in_w[k] / in_w[k+1];
        if (factor_h != factor_w || factor_h < 1) { rc = -EINVAL; goto fpn_fail; }
        float *up = (float *)malloc(sizeof(float) * 256 * (size_t)in_h[k] * in_w[k]);
        if (!up) { rc = -ENOMEM; goto fpn_fail; }
        doctr_upsample_bilinear_ref(p[k+1], 256, in_h[k+1], in_w[k+1], factor_h, up);
        /* p[k] = in_b[k] + up */
        p[k] = (float *)malloc(sizeof(float) * 256 * (size_t)in_h[k] * in_w[k]);
        if (!p[k]) { free(up); rc = -ENOMEM; goto fpn_fail; }
        for (int i = 0; i < 256 * in_h[k] * in_w[k]; ++i) p[k][i] = in_b[k][i] + up[i];
        free(up);
        free(in_b[k]); in_b[k] = NULL;
    }
    /* in_b[0..2] freed above; p[0..3] now own the FPN intermediates. */

    /* out_branches: 3x3 conv 256 -> 64 + BN, then upsample each to layer1's
     * spatial size and concat to (256, h1, w1). */
    float *out_b[4] = {0};
    int   out_h[4], out_w[4];
    for (int i = 0; i < 4; ++i) {
        char conv_n[200], bn_n[200];
        snprintf(conv_n, sizeof conv_n, "det.fpn.out_branches.%d.0", i);
        snprintf(bn_n,   sizeof bn_n,   "det.fpn.out_branches.%d.1", i);
        rc = conv_bn_relu_fresh(s->gguf, conv_n, bn_n, false,
                                1, 1, 1, 1,
                                p[i], 256, in_h[i], in_w[i], 64, 3, 3,
                                &out_b[i], &out_h[i], &out_w[i]);
        free(p[i]); p[i] = NULL;
        if (rc != 0) goto fpn_fail;
    }

    /* Upsample each branch to (64, in_h[0], in_w[0]) then concat. */
    int ch0 = in_h[0], cw0 = in_w[0];
    float *concat = (float *)malloc(sizeof(float) * 256 * (size_t)ch0 * cw0);
    if (!concat) { rc = -ENOMEM; goto fpn_fail; }
    for (int i = 0; i < 4; ++i) {
        if (out_h[i] == ch0 && out_w[i] == cw0) {
            memcpy(concat + (size_t)i * 64 * ch0 * cw0,
                   out_b[i], sizeof(float) * 64 * (size_t)ch0 * cw0);
        } else {
            int factor = ch0 / out_h[i];
            float *up = (float *)malloc(sizeof(float) * 64 * (size_t)ch0 * cw0);
            if (!up) { free(concat); rc = -ENOMEM; goto fpn_fail; }
            doctr_upsample_bilinear_ref(out_b[i], 64, out_h[i], out_w[i], factor, up);
            memcpy(concat + (size_t)i * 64 * ch0 * cw0,
                   up, sizeof(float) * 64 * (size_t)ch0 * cw0);
            free(up);
        }
        free(out_b[i]); out_b[i] = NULL;
    }

    /* prob_head:
     *   .0  Conv2d 256->64, k=3, padding=1
     *   .1  BN(64), ReLU
     *   .3  ConvTranspose2d 64->64, kernel=2, stride=2  (with bias)
     *   .4  BN(64), ReLU
     *   .6  ConvTranspose2d 64->1, kernel=2, stride=2 (with bias)
     *   sigmoid
     */
    float *ph0 = NULL; int ph0_h, ph0_w;
    rc = conv_bn_relu_fresh(s->gguf, "det.prob_head.0", "det.prob_head.1", true,
                            1, 1, 1, 1,
                            concat, 256, ch0, cw0, 64, 3, 3,
                            &ph0, &ph0_h, &ph0_w);
    free(concat);
    if (rc != 0) goto fpn_fail;

    int64_t dims[4]; int nd;
    snprintf(buf, sizeof buf, "det.prob_head.3.weight");
    const float *ct1_w = T(s->gguf, buf, dims, &nd);
    snprintf(buf, sizeof buf, "det.prob_head.3.bias");
    const float *ct1_b = T(s->gguf, buf, dims, &nd);
    if (!ct1_w) { free(ph0); rc = -EINVAL; goto fpn_fail; }

    int ph1_h = ph0_h * 2, ph1_w = ph0_w * 2;
    float *ph1 = (float *)malloc(sizeof(float) * 64 * (size_t)ph1_h * ph1_w);
    if (!ph1) { free(ph0); rc = -ENOMEM; goto fpn_fail; }
    doctr_conv_transpose_2x2_s2_ref(ph0, 64, ph0_h, ph0_w, ct1_w, 64, ct1_b, ph1);
    free(ph0);

    /* BN(64) + ReLU. */
    snprintf(buf, sizeof buf, "det.prob_head.4.weight");
    const float *bn4_g = T(s->gguf, buf, dims, &nd);
    snprintf(buf, sizeof buf, "det.prob_head.4.bias");
    const float *bn4_b = T(s->gguf, buf, dims, &nd);
    snprintf(buf, sizeof buf, "det.prob_head.4.running_mean");
    const float *bn4_m = T(s->gguf, buf, dims, &nd);
    snprintf(buf, sizeof buf, "det.prob_head.4.running_var");
    const float *bn4_v = T(s->gguf, buf, dims, &nd);
    if (!bn4_g || !bn4_b || !bn4_m || !bn4_v) { free(ph1); rc = -EINVAL; goto fpn_fail; }
    float bn4_scale[64], bn4_shift[64];
    doctr_bn_fold(bn4_g, bn4_b, bn4_m, bn4_v, 1e-5f, 64, bn4_scale, bn4_shift);
    doctr_apply_affine_relu(ph1, 64, ph1_h * ph1_w, bn4_scale, bn4_shift, true);

    snprintf(buf, sizeof buf, "det.prob_head.6.weight");
    const float *ct2_w = T(s->gguf, buf, dims, &nd);
    snprintf(buf, sizeof buf, "det.prob_head.6.bias");
    const float *ct2_b = T(s->gguf, buf, dims, &nd);
    if (!ct2_w) { free(ph1); rc = -EINVAL; goto fpn_fail; }

    int ph2_h = ph1_h * 2, ph2_w = ph1_w * 2;
    float *ph2 = (float *)malloc(sizeof(float) * 1 * (size_t)ph2_h * ph2_w);
    if (!ph2) { free(ph1); rc = -ENOMEM; goto fpn_fail; }
    doctr_conv_transpose_2x2_s2_ref(ph1, 64, ph1_h, ph1_w, ct2_w, 1, ct2_b, ph2);
    free(ph1);

    /* Sigmoid in place. */
    doctr_sigmoid_inplace(ph2, ph2_h * ph2_w);

    /* Postprocess. */
    size_t n_total = 0;
    size_t n_emit = doctr_dbnet_postprocess(
        ph2, ph2_h, ph2_w,
        image->width, image->height, scaled_w, scaled_h, target,
        out, max_detections, &n_total);
    free(ph2);

    if (out_count) *out_count = (n_total > max_detections) ? n_total : n_emit;
    if (n_total > max_detections) return -ENOSPC;
    return 0;

fpn_fail:
    for (int i = 0; i < 4; ++i) { free(in_b[i]); free(p[i]); free(out_b[i]); }
    return rc;
}
