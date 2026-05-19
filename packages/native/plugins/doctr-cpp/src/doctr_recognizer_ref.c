/*
 * crnn_vgg16_bn forward pass — pure-C reference.
 *
 * Backbone: a VGG-16-with-batchnorm tower, but doctr's variant
 * differs from torchvision in one important detail — the maxpools are
 * spaced to preserve the *width* dimension after the first three pools
 * and only collapse height. That keeps a useful per-column feature
 * sequence for the BiLSTM. The exact layer plan is read off the
 * state_dict shipped by python-doctr 1.0.1:
 *
 *   feat_extractor.0   Conv2d(3, 64, 3, padding=1)
 *   feat_extractor.1   BatchNorm2d(64)
 *   feat_extractor.2   ReLU(inplace=True)
 *   feat_extractor.3   Conv2d(64, 64, 3, padding=1)
 *   feat_extractor.4   BatchNorm2d(64)
 *   feat_extractor.5   ReLU(inplace=True)
 *   feat_extractor.6   MaxPool2d(2, 2)            # 32x128 -> 16x64
 *   feat_extractor.7   Conv2d(64, 128, 3, padding=1)
 *   feat_extractor.8   BatchNorm2d(128)
 *   feat_extractor.9   ReLU
 *   feat_extractor.10  Conv2d(128, 128, 3, padding=1)
 *   feat_extractor.11  BatchNorm2d(128)
 *   feat_extractor.12  ReLU
 *   feat_extractor.13  MaxPool2d(2, 2)            # 16x64 -> 8x32
 *   feat_extractor.14  Conv2d(128, 256, 3, padding=1)
 *   feat_extractor.15  BatchNorm2d(256)
 *   feat_extractor.16  ReLU
 *   feat_extractor.17  Conv2d(256, 256, 3, padding=1)
 *   feat_extractor.18  BatchNorm2d(256)
 *   feat_extractor.19  ReLU
 *   feat_extractor.20  Conv2d(256, 256, 3, padding=1)
 *   feat_extractor.21  BatchNorm2d(256)
 *   feat_extractor.22  ReLU
 *   feat_extractor.23  MaxPool2d((2,1), (2,1))    # 8x32 -> 4x32
 *   feat_extractor.24  Conv2d(256, 512, 3, padding=1)
 *   feat_extractor.25  BatchNorm2d(512)
 *   feat_extractor.26  ReLU
 *   feat_extractor.27  Conv2d(512, 512, 3, padding=1)
 *   feat_extractor.28  BatchNorm2d(512)
 *   feat_extractor.29  ReLU
 *   feat_extractor.30  Conv2d(512, 512, 3, padding=1)
 *   feat_extractor.31  BatchNorm2d(512)
 *   feat_extractor.32  ReLU
 *   feat_extractor.33  MaxPool2d((2,1), (2,1))    # 4x32 -> 2x32
 *   feat_extractor.34  Conv2d(512, 512, 3, padding=1)
 *   feat_extractor.35  BatchNorm2d(512)
 *   feat_extractor.36  ReLU
 *   feat_extractor.37  Conv2d(512, 512, 3, padding=1)
 *   feat_extractor.38  BatchNorm2d(512)
 *   feat_extractor.39  ReLU
 *   feat_extractor.40  Conv2d(512, 512, (2,2), stride=(2,1), padding=(0,1)) # 2x32 -> 1x33
 *   feat_extractor.41  BatchNorm2d(512)
 *   feat_extractor.42  ReLU
 *
 * After the backbone we have a (512, 1, T) feature map. Doctr squeezes
 * the height-1 dim and treats T as the time axis with 512-dim per
 * timestep. The decoder is a 2-layer bidirectional LSTM with hidden
 * size 128 (so concat output is 256), then a linear head to vocab+1.
 * Greedy CTC decode produces the final string.
 *
 * Recognizer input contract (per the C ABI in doctr.h): the caller
 * passes a height-32 RGB crop. We resize the width to a multiple of
 * 4 (the receptive-field stride along W is 1 except for the last
 * 4-stride aggregate, but doctr pads to width 128 by default; we
 * preserve the caller's width as long as it's a sane positive). For
 * the test fixture we'll always feed 32x128.
 */

#include "doctr_internal.h"
#include "doctr_session.h"

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/* Helper to look up a tensor (returns NULL when missing). */
static const float *T(const doctr_gguf *g, const char *name,
                      int64_t *dims, int *ndim)
{
    return doctr_gguf_get_f32(g, name, dims, 4, ndim);
}

/* Run a Conv2D + BN + ReLU block. The BN params (gamma, beta, mean,
 * var) are looked up by name and folded into a per-channel
 * (scale, shift) pair, then applied in-place after the conv.
 *
 * Returns 0 on success or -EINVAL when any tensor is missing/wrong shape. */
static int conv_bn_relu(
    const doctr_gguf *g,
    const char *conv_prefix, /* e.g. "rec.feat_extractor.0" */
    const char *bn_prefix,   /* e.g. "rec.feat_extractor.1" */
    int strideh, int stridew, int padh, int padw,
    const float *x, int cin, int hin, int win,
    int cout_expected, int kh, int kw,
    float **scratch, size_t *scratch_cap,
    float **out, int *hout, int *wout, int *cout_actual)
{
    char buf[128];
    int64_t dims[4]; int nd;

    snprintf(buf, sizeof buf, "%s.weight", conv_prefix);
    const float *w = T(g, buf, dims, &nd);
    if (!w || nd != 4 || dims[0] != cout_expected || dims[1] != cin || dims[2] != kh || dims[3] != kw) return -EINVAL;
    snprintf(buf, sizeof buf, "%s.bias", conv_prefix);
    const float *b = T(g, buf, dims, &nd);  /* may be NULL when conv has no bias */

    const int H = (hin + 2 * padh - kh) / strideh + 1;
    const int W = (win + 2 * padw - kw) / stridew + 1;

    size_t need = (size_t)cout_expected * H * W;
    if (*scratch_cap < need) {
        float *nb = (float *)realloc(*scratch, sizeof(float) * need);
        if (!nb) return -ENOMEM;
        *scratch = nb; *scratch_cap = need;
    }
    float *y = *scratch;
    doctr_conv2d_ref(x, cin, hin, win, w, cout_expected, kh, kw, b,
                     strideh, stridew, padh, padw, y);

    /* BN. */
    snprintf(buf, sizeof buf, "%s.weight", bn_prefix);
    const float *gamma = T(g, buf, dims, &nd); if (!gamma) return -EINVAL;
    snprintf(buf, sizeof buf, "%s.bias", bn_prefix);
    const float *beta  = T(g, buf, dims, &nd); if (!beta) return -EINVAL;
    snprintf(buf, sizeof buf, "%s.running_mean", bn_prefix);
    const float *mean  = T(g, buf, dims, &nd); if (!mean) return -EINVAL;
    snprintf(buf, sizeof buf, "%s.running_var", bn_prefix);
    const float *var   = T(g, buf, dims, &nd); if (!var) return -EINVAL;
    float *scale = (float *)malloc(sizeof(float) * cout_expected * 2);
    if (!scale) return -ENOMEM;
    float *shift = scale + cout_expected;
    doctr_bn_fold(gamma, beta, mean, var, 1e-5f, cout_expected, scale, shift);
    doctr_apply_affine_relu(y, cout_expected, H * W, scale, shift, true);
    free(scale);

    *out = y;
    *hout = H; *wout = W; *cout_actual = cout_expected;
    return 0;
}

/* Allocate a fresh aligned float buffer; freed by the caller. */
static float *fresh(size_t n) { return (float *)malloc(sizeof(float) * n); }

int doctr_recognizer_forward(
    doctr_session *s, const doctr_image *crop, doctr_recognition *out)
{
    if (!s || !crop || !out) return -EINVAL;
    if (crop->width <= 0 || crop->height <= 0 || !crop->rgb) return -EINVAL;

    /* Resize/normalize to (32, target_w). Use a 4x of input height as
     * the working width, matching doctr's default 32x128 unless the
     * caller already passed a 32-tall crop, in which case we keep the
     * existing width clamped to a sane minimum. */
    const int target_h = 32;
    int target_w = crop->width;
    if (target_w < 32) target_w = 32;
    if (target_w > 1024) target_w = 1024;

    float *x0 = fresh((size_t)3 * target_h * target_w);
    if (!x0) return -ENOMEM;
    int rc = doctr_resize_rgb_to_chw(crop->rgb, crop->width, crop->height,
                                     x0, target_h, target_w);
    if (rc != 0) { free(x0); return rc; }

    /* ── VGG-16-BN backbone ──────────────────────────────────────────── */
    float *cur = x0;
    int cc = 3, ch = target_h, cw = target_w;
    float *scratch = NULL; size_t scratch_cap = 0;
    float *next = NULL; int nh = 0, nw = 0, nc = 0;

#define CBR(conv_idx, bn_idx, in_c, out_c, sh_, sw_, ph_, pw_, kh_, kw_) do { \
    char cp[64], bp[64];                                                       \
    snprintf(cp, sizeof cp, "rec.feat_extractor.%d", conv_idx);                \
    snprintf(bp, sizeof bp, "rec.feat_extractor.%d", bn_idx);                  \
    rc = conv_bn_relu(s->gguf, cp, bp, sh_, sw_, ph_, pw_,                      \
                      cur, in_c, ch, cw, out_c, kh_, kw_,                       \
                      &scratch, &scratch_cap, &next, &nh, &nw, &nc);            \
    if (rc != 0) goto done;                                                    \
    if (cur != x0) free(cur);                                                  \
    /* Move the result out of the shared scratch into a fresh buffer so the
       next conv may reuse scratch. */                                          \
    cur = fresh((size_t)nc * nh * nw);                                          \
    if (!cur) { rc = -ENOMEM; goto done; }                                      \
    memcpy(cur, next, sizeof(float) * (size_t)nc * nh * nw);                    \
    cc = nc; ch = nh; cw = nw;                                                  \
} while (0)

#define MP(kh_, kw_, sh_, sw_) do {                                            \
    int H_ = (ch - kh_) / sh_ + 1;                                              \
    int W_ = (cw - kw_) / sw_ + 1;                                              \
    float *p = fresh((size_t)cc * H_ * W_);                                    \
    if (!p) { rc = -ENOMEM; goto done; }                                       \
    doctr_maxpool2d_ref(cur, cc, ch, cw, kh_, kw_, sh_, sw_, 0, 0, p);          \
    free(cur); cur = p; ch = H_; cw = W_;                                       \
} while (0)

    CBR(0,  1,  3,  64,  1, 1, 1, 1, 3, 3);
    CBR(3,  4,  64, 64,  1, 1, 1, 1, 3, 3);
    MP(2, 2, 2, 2);
    CBR(7,  8,  64, 128, 1, 1, 1, 1, 3, 3);
    CBR(10, 11, 128,128, 1, 1, 1, 1, 3, 3);
    MP(2, 2, 2, 2);
    CBR(14, 15, 128,256, 1, 1, 1, 1, 3, 3);
    CBR(17, 18, 256,256, 1, 1, 1, 1, 3, 3);
    CBR(20, 21, 256,256, 1, 1, 1, 1, 3, 3);
    MP(2, 1, 2, 1);
    CBR(24, 25, 256,512, 1, 1, 1, 1, 3, 3);
    CBR(27, 28, 512,512, 1, 1, 1, 1, 3, 3);
    CBR(30, 31, 512,512, 1, 1, 1, 1, 3, 3);
    MP(2, 1, 2, 1);
    CBR(34, 35, 512,512, 1, 1, 1, 1, 3, 3);
    CBR(37, 38, 512,512, 1, 1, 1, 1, 3, 3);
    /* Final conv has kernel 2x2, stride (2,1), padding (0,1). */
    CBR(40, 41, 512,512, 2, 1, 0, 1, 2, 2);

#undef CBR
#undef MP

    free(scratch); scratch = NULL;

    /* After the final conv, we should have feature map (512, 1, T)
     * where T == target_w/4 + 1 ish. Doctr drops the height dim; we
     * walk the time axis. */
    if (ch != 1) { rc = -EINVAL; goto done; }
    int T_steps = cw;
    int feat_dim = cc;  /* 512 */

    /* ── 2-layer bidirectional LSTM ──────────────────────────────────── */
    int64_t dims[4]; int nd;
    const float *w_ih_l0  = T(s->gguf, "rec.decoder.weight_ih_l0",        dims, &nd); if (!w_ih_l0)  { rc = -EINVAL; goto done; }
    const float *w_hh_l0  = T(s->gguf, "rec.decoder.weight_hh_l0",        dims, &nd); if (!w_hh_l0)  { rc = -EINVAL; goto done; }
    const float *b_ih_l0  = T(s->gguf, "rec.decoder.bias_ih_l0",          dims, &nd); if (!b_ih_l0)  { rc = -EINVAL; goto done; }
    const float *b_hh_l0  = T(s->gguf, "rec.decoder.bias_hh_l0",          dims, &nd); if (!b_hh_l0)  { rc = -EINVAL; goto done; }
    const float *w_ih_l0r = T(s->gguf, "rec.decoder.weight_ih_l0_reverse",dims, &nd); if (!w_ih_l0r) { rc = -EINVAL; goto done; }
    const float *w_hh_l0r = T(s->gguf, "rec.decoder.weight_hh_l0_reverse",dims, &nd); if (!w_hh_l0r) { rc = -EINVAL; goto done; }
    const float *b_ih_l0r = T(s->gguf, "rec.decoder.bias_ih_l0_reverse",  dims, &nd); if (!b_ih_l0r) { rc = -EINVAL; goto done; }
    const float *b_hh_l0r = T(s->gguf, "rec.decoder.bias_hh_l0_reverse",  dims, &nd); if (!b_hh_l0r) { rc = -EINVAL; goto done; }
    const float *w_ih_l1  = T(s->gguf, "rec.decoder.weight_ih_l1",        dims, &nd); if (!w_ih_l1)  { rc = -EINVAL; goto done; }
    const float *w_hh_l1  = T(s->gguf, "rec.decoder.weight_hh_l1",        dims, &nd); if (!w_hh_l1)  { rc = -EINVAL; goto done; }
    const float *b_ih_l1  = T(s->gguf, "rec.decoder.bias_ih_l1",          dims, &nd); if (!b_ih_l1)  { rc = -EINVAL; goto done; }
    const float *b_hh_l1  = T(s->gguf, "rec.decoder.bias_hh_l1",          dims, &nd); if (!b_hh_l1)  { rc = -EINVAL; goto done; }
    const float *w_ih_l1r = T(s->gguf, "rec.decoder.weight_ih_l1_reverse",dims, &nd); if (!w_ih_l1r) { rc = -EINVAL; goto done; }
    const float *w_hh_l1r = T(s->gguf, "rec.decoder.weight_hh_l1_reverse",dims, &nd); if (!w_hh_l1r) { rc = -EINVAL; goto done; }
    const float *b_ih_l1r = T(s->gguf, "rec.decoder.bias_ih_l1_reverse",  dims, &nd); if (!b_ih_l1r) { rc = -EINVAL; goto done; }
    const float *b_hh_l1r = T(s->gguf, "rec.decoder.bias_hh_l1_reverse",  dims, &nd); if (!b_hh_l1r) { rc = -EINVAL; goto done; }

    const int H_lstm = 128;
    /* Input to the BiLSTM is one 512-vector per timestep. We materialize
     * it by reading `cur` channel-by-channel: cur is (cc, 1, T), so
     * index t -> cur[c * T + t]. */
    float *step_in = fresh((size_t)feat_dim);
    float *h0  = fresh((size_t)H_lstm);
    float *c0  = fresh((size_t)H_lstm);
    float *h0r = fresh((size_t)H_lstm);
    float *c0r = fresh((size_t)H_lstm);
    /* Layer-0 outputs forward+reverse, concatenated to 2*H_lstm dim per timestep. */
    float *lay0 = fresh((size_t)T_steps * 2 * H_lstm);
    if (!step_in || !h0 || !c0 || !h0r || !c0r || !lay0) { rc = -ENOMEM; goto lstm_oom; }
    memset(h0, 0, sizeof(float) * H_lstm);
    memset(c0, 0, sizeof(float) * H_lstm);
    memset(h0r, 0, sizeof(float) * H_lstm);
    memset(c0r, 0, sizeof(float) * H_lstm);

    /* Forward direction. */
    for (int t = 0; t < T_steps; ++t) {
        for (int c = 0; c < feat_dim; ++c) step_in[c] = cur[(size_t)c * T_steps + t];
        doctr_lstm_step_ref(step_in, feat_dim, h0, c0, H_lstm,
                            w_ih_l0, w_hh_l0, b_ih_l0, b_hh_l0);
        memcpy(lay0 + (size_t)t * 2 * H_lstm, h0, sizeof(float) * H_lstm);
    }
    /* Reverse direction. */
    for (int t = T_steps - 1; t >= 0; --t) {
        for (int c = 0; c < feat_dim; ++c) step_in[c] = cur[(size_t)c * T_steps + t];
        doctr_lstm_step_ref(step_in, feat_dim, h0r, c0r, H_lstm,
                            w_ih_l0r, w_hh_l0r, b_ih_l0r, b_hh_l0r);
        memcpy(lay0 + (size_t)t * 2 * H_lstm + H_lstm, h0r, sizeof(float) * H_lstm);
    }

    /* Layer 1 — input is now (T_steps, 2*H_lstm). */
    float *h1  = fresh((size_t)H_lstm);
    float *c1  = fresh((size_t)H_lstm);
    float *h1r = fresh((size_t)H_lstm);
    float *c1r = fresh((size_t)H_lstm);
    float *lay1 = fresh((size_t)T_steps * 2 * H_lstm);
    if (!h1 || !c1 || !h1r || !c1r || !lay1) { rc = -ENOMEM; goto lstm_oom; }
    memset(h1, 0, sizeof(float) * H_lstm);
    memset(c1, 0, sizeof(float) * H_lstm);
    memset(h1r, 0, sizeof(float) * H_lstm);
    memset(c1r, 0, sizeof(float) * H_lstm);
    const int in1 = 2 * H_lstm;
    for (int t = 0; t < T_steps; ++t) {
        const float *xv = lay0 + (size_t)t * in1;
        doctr_lstm_step_ref(xv, in1, h1, c1, H_lstm,
                            w_ih_l1, w_hh_l1, b_ih_l1, b_hh_l1);
        memcpy(lay1 + (size_t)t * in1, h1, sizeof(float) * H_lstm);
    }
    for (int t = T_steps - 1; t >= 0; --t) {
        const float *xv = lay0 + (size_t)t * in1;
        doctr_lstm_step_ref(xv, in1, h1r, c1r, H_lstm,
                            w_ih_l1r, w_hh_l1r, b_ih_l1r, b_hh_l1r);
        memcpy(lay1 + (size_t)t * in1 + H_lstm, h1r, sizeof(float) * H_lstm);
    }

    /* ── Linear head ─────────────────────────────────────────────────── */
    const float *lin_w = T(s->gguf, "rec.linear.weight", dims, &nd);
    if (!lin_w || nd != 2) { rc = -EINVAL; goto lstm_oom; }
    int alphabet = (int)dims[0];
    const float *lin_b = T(s->gguf, "rec.linear.bias", dims, &nd);

    float *logits = fresh((size_t)T_steps * alphabet);
    if (!logits) { rc = -ENOMEM; goto lstm_oom; }
    doctr_linear_ref(lay1, T_steps, in1, lin_w, alphabet, lin_b, logits);

    /* ── CTC greedy decode ───────────────────────────────────────────── */
    rc = doctr_ctc_greedy_decode(
        logits, T_steps, alphabet,
        s->vocab_utf8, s->vocab_len,
        out->text_utf8, out->text_utf8_capacity, &out->text_utf8_length,
        out->char_confidences, out->char_confidences_capacity, &out->char_confidences_length);

    free(logits);
lstm_oom:
    free(step_in); free(h0); free(c0); free(h0r); free(c0r); free(lay0);
    free(h1); free(c1); free(h1r); free(c1r); free(lay1);
done:
    free(cur); free(scratch);
    return rc;
}
