/*
 * face_blazeface.c — BlazeFace front-model forward pass.
 *
 * Architecture (verified against hollance/BlazeFace-PyTorch master,
 * the canonical PyTorch port of the MediaPipe
 * face_detection_front.tflite):
 *
 *   Input: (3, 128, 128) RGB normalized to [-1, 1]
 *   F.pad((1, 2, 1, 2))                       → (3, 131, 131)
 *   backbone1[0]:  Conv2d(3, 24, 5, s=2, p=0) → (24, 64, 64)
 *   backbone1[1]:  ReLU
 *   backbone1[2]:  BlazeBlock(24, 24)         → (24, 64, 64)
 *   backbone1[3]:  BlazeBlock(24, 28)         → (28, 64, 64)
 *   backbone1[4]:  BlazeBlock(28, 32, s=2)    → (32, 32, 32)
 *   backbone1[5]:  BlazeBlock(32, 36)         → (36, 32, 32)
 *   backbone1[6]:  BlazeBlock(36, 42)         → (42, 32, 32)
 *   backbone1[7]:  BlazeBlock(42, 48, s=2)    → (48, 16, 16)
 *   backbone1[8]:  BlazeBlock(48, 56)         → (56, 16, 16)
 *   backbone1[9]:  BlazeBlock(56, 64)         → (64, 16, 16)
 *   backbone1[10]: BlazeBlock(64, 72)         → (72, 16, 16)
 *   backbone1[11]: BlazeBlock(72, 80)         → (80, 16, 16)
 *   backbone1[12]: BlazeBlock(80, 88)         → (88, 16, 16)   ← x
 *
 *   backbone2[0]:  BlazeBlock(88, 96, s=2)    → (96, 8, 8)
 *   backbone2[1..4]: BlazeBlock(96, 96)       → (96, 8, 8)     ← h
 *
 *   classifier_8(x)   = Conv2d(88, 2, 1)      → (2, 16, 16)
 *   classifier_16(h)  = Conv2d(96, 6, 1)      → (6, 8, 8)
 *   regressor_8(x)    = Conv2d(88, 32, 1)     → (32, 16, 16)
 *   regressor_16(h)   = Conv2d(96, 96, 1)     → (96, 8, 8)
 *
 *   reshape + concat per anchor:
 *     scores: (896,) — 16*16*2 + 8*8*6
 *     regressors: (896, 16) — 4 bbox + 6 keypoint pairs
 *
 * BlazeBlock(in, out, stride=1):
 *   y = depthwise_conv(x, k=3, s=1, p=1, bias)
 *   y = pointwise_conv(y, in→out, bias)
 *   r = pad_channels(x, out - in)
 *   return ReLU(y + r)
 *
 * BlazeBlock(in, out, stride=2):
 *   x_padded = F.pad(x, (0, 2, 0, 2))
 *   y = depthwise_conv(x_padded, k=3, s=2, p=0, bias)
 *   y = pointwise_conv(y, in→out, bias)
 *   r = MaxPool2d(x, k=2, s=2)
 *   r = pad_channels(r, out - in)
 *   return ReLU(y + r)
 *
 * The hollance .pth has BN already folded into conv biases (no
 * separate BN tensors). The converter writes everything as fp16 by
 * default; the GGUF reader inflates to fp32 on load.
 *
 * Tensor naming in the GGUF (matches the PyTorch state-dict keys):
 *   det.backbone1.0.weight             (24, 3, 5, 5)
 *   det.backbone1.0.bias               (24,)
 *   det.backbone1.2.convs.0.weight     (24, 1, 3, 3)
 *   det.backbone1.2.convs.0.bias       (24,)
 *   det.backbone1.2.convs.1.weight     (24, 24, 1, 1)
 *   det.backbone1.2.convs.1.bias       (24,)
 *   ...
 *   det.classifier_8.weight            (2, 88, 1, 1)
 *   det.classifier_8.bias              (2,)
 *   det.classifier_16.weight           (6, 96, 1, 1)
 *   det.classifier_16.bias             (6,)
 *   det.regressor_8.weight             (32, 88, 1, 1)
 *   det.regressor_8.bias               (32,)
 *   det.regressor_16.weight            (96, 96, 1, 1)
 *   det.regressor_16.bias              (96,)
 */

#include "face_internal.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The 12 BlazeBlocks in backbone1 (after the initial conv + relu),
 * indexed by their position in the nn.Sequential. Tuple is
 * (state-dict-index, in_channels, out_channels, stride). */
static const struct {
    int seq_idx;
    int cin;
    int cout;
    int stride;
} BLOCKS_B1[] = {
    {  2, 24, 24, 1 },
    {  3, 24, 28, 1 },
    {  4, 28, 32, 2 },
    {  5, 32, 36, 1 },
    {  6, 36, 42, 1 },
    {  7, 42, 48, 2 },
    {  8, 48, 56, 1 },
    {  9, 56, 64, 1 },
    { 10, 64, 72, 1 },
    { 11, 72, 80, 1 },
    { 12, 80, 88, 1 },
};
#define N_BLOCKS_B1 (int)(sizeof(BLOCKS_B1) / sizeof(BLOCKS_B1[0]))

static const struct {
    int seq_idx;
    int cin;
    int cout;
    int stride;
} BLOCKS_B2[] = {
    { 0, 88, 96, 2 },
    { 1, 96, 96, 1 },
    { 2, 96, 96, 1 },
    { 3, 96, 96, 1 },
    { 4, 96, 96, 1 },
};
#define N_BLOCKS_B2 (int)(sizeof(BLOCKS_B2) / sizeof(BLOCKS_B2[0]))

typedef struct {
    /* depthwise conv (in_channels, 1, 3, 3) + bias (in_channels) */
    const float *dw_w;
    float       *dw_w_owned;
    const float *dw_b;
    float       *dw_b_owned;
    /* pointwise conv (out, in, 1, 1) + bias (out) */
    const float *pw_w;
    float       *pw_w_owned;
    const float *pw_b;
    float       *pw_b_owned;
    int cin, cout, stride;
} bf_block;

struct face_blazeface_state {
    /* stem conv: (24, 3, 5, 5) + (24) */
    const float *stem_w;
    float       *stem_w_owned;
    const float *stem_b;
    float       *stem_b_owned;

    bf_block b1[N_BLOCKS_B1];
    bf_block b2[N_BLOCKS_B2];

    /* heads */
    const float *cls8_w;  float *cls8_w_owned;
    const float *cls8_b;  float *cls8_b_owned;
    const float *cls16_w; float *cls16_w_owned;
    const float *cls16_b; float *cls16_b_owned;
    const float *reg8_w;  float *reg8_w_owned;
    const float *reg8_b;  float *reg8_b_owned;
    const float *reg16_w; float *reg16_w_owned;
    const float *reg16_b; float *reg16_b_owned;
};

/* MAX_TENSOR_DIMS_FACE matches the 4 we use throughout the BlazeFace
 * weights (NCHW conv). */
#define MAX_TENSOR_DIMS_FACE 4

/* Take ownership of the converted-to-fp32 buffer if needed; clears
 * `*owned` on success so the caller knows we adopted it. */
static const float *T(const face_gguf *g, const char *name,
                      int64_t *dims, int *ndim, float **owned)
{
    return face_gguf_get_f32_view(g, name, dims, MAX_TENSOR_DIMS_FACE, ndim, owned);
}

static int load_block(const face_gguf *g, const char *prefix,
                      int cin, int cout, int stride, bf_block *out)
{
    char buf[128];
    int64_t dims[4]; int nd;

    snprintf(buf, sizeof buf, "%s.convs.0.weight", prefix);
    out->dw_w = T(g, buf, dims, &nd, &out->dw_w_owned);
    if (!out->dw_w || nd != 4 || dims[0] != cin || dims[1] != 1
        || dims[2] != 3 || dims[3] != 3) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.convs.0.bias", prefix);
    out->dw_b = T(g, buf, dims, &nd, &out->dw_b_owned);
    if (!out->dw_b || nd != 1 || dims[0] != cin) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.convs.1.weight", prefix);
    out->pw_w = T(g, buf, dims, &nd, &out->pw_w_owned);
    if (!out->pw_w || nd != 4 || dims[0] != cout || dims[1] != cin
        || dims[2] != 1 || dims[3] != 1) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.convs.1.bias", prefix);
    out->pw_b = T(g, buf, dims, &nd, &out->pw_b_owned);
    if (!out->pw_b || nd != 1 || dims[0] != cout) return -EINVAL;

    out->cin = cin; out->cout = cout; out->stride = stride;
    return 0;
}

static int load_head(const face_gguf *g, const char *prefix,
                     int cin, int cout,
                     const float **wp, float **wp_owned,
                     const float **bp, float **bp_owned)
{
    char buf[128];
    int64_t dims[4]; int nd;

    snprintf(buf, sizeof buf, "%s.weight", prefix);
    *wp = T(g, buf, dims, &nd, wp_owned);
    if (!*wp || nd != 4 || dims[0] != cout || dims[1] != cin
        || dims[2] != 1 || dims[3] != 1) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.bias", prefix);
    *bp = T(g, buf, dims, &nd, bp_owned);
    if (!*bp || nd != 1 || dims[0] != cout) return -EINVAL;
    return 0;
}

face_blazeface_state *face_blazeface_state_new(const face_gguf *g, int *err) {
    if (err) *err = 0;
    face_blazeface_state *s = (face_blazeface_state *)calloc(1, sizeof(*s));
    if (!s) { if (err) *err = -ENOMEM; return NULL; }

    int rc;
    int64_t dims[4]; int nd;
    char buf[160];

    /* stem: backbone1.0 */
    s->stem_w = T(g, "det.backbone1.0.weight", dims, &nd, &s->stem_w_owned);
    if (!s->stem_w || nd != 4 || dims[0] != 24 || dims[1] != 3
        || dims[2] != 5 || dims[3] != 5) { rc = -EINVAL; goto fail; }
    s->stem_b = T(g, "det.backbone1.0.bias", dims, &nd, &s->stem_b_owned);
    if (!s->stem_b || nd != 1 || dims[0] != 24) { rc = -EINVAL; goto fail; }

    for (int i = 0; i < N_BLOCKS_B1; ++i) {
        snprintf(buf, sizeof buf, "det.backbone1.%d", BLOCKS_B1[i].seq_idx);
        rc = load_block(g, buf, BLOCKS_B1[i].cin, BLOCKS_B1[i].cout,
                        BLOCKS_B1[i].stride, &s->b1[i]);
        if (rc) goto fail;
    }
    for (int i = 0; i < N_BLOCKS_B2; ++i) {
        snprintf(buf, sizeof buf, "det.backbone2.%d", BLOCKS_B2[i].seq_idx);
        rc = load_block(g, buf, BLOCKS_B2[i].cin, BLOCKS_B2[i].cout,
                        BLOCKS_B2[i].stride, &s->b2[i]);
        if (rc) goto fail;
    }

    rc = load_head(g, "det.classifier_8",  88,  2,
                   &s->cls8_w,  &s->cls8_w_owned,  &s->cls8_b,  &s->cls8_b_owned);
    if (rc) goto fail;
    rc = load_head(g, "det.classifier_16", 96,  6,
                   &s->cls16_w, &s->cls16_w_owned, &s->cls16_b, &s->cls16_b_owned);
    if (rc) goto fail;
    rc = load_head(g, "det.regressor_8",   88, 32,
                   &s->reg8_w,  &s->reg8_w_owned,  &s->reg8_b,  &s->reg8_b_owned);
    if (rc) goto fail;
    rc = load_head(g, "det.regressor_16",  96, 96,
                   &s->reg16_w, &s->reg16_w_owned, &s->reg16_b, &s->reg16_b_owned);
    if (rc) goto fail;

    return s;

fail:
    if (err) *err = rc;
    face_blazeface_state_free(s);
    return NULL;
}

static void free_block(bf_block *b) {
    free(b->dw_w_owned);
    free(b->dw_b_owned);
    free(b->pw_w_owned);
    free(b->pw_b_owned);
}

void face_blazeface_state_free(face_blazeface_state *s) {
    if (!s) return;
    free(s->stem_w_owned);
    free(s->stem_b_owned);
    for (int i = 0; i < N_BLOCKS_B1; ++i) free_block(&s->b1[i]);
    for (int i = 0; i < N_BLOCKS_B2; ++i) free_block(&s->b2[i]);
    free(s->cls8_w_owned);  free(s->cls8_b_owned);
    free(s->cls16_w_owned); free(s->cls16_b_owned);
    free(s->reg8_w_owned);  free(s->reg8_b_owned);
    free(s->reg16_w_owned); free(s->reg16_b_owned);
    free(s);
}

/* Helper: pad input (cin, hin, win) to (cout, hin, win) by appending
 * zero channels. cout >= cin. */
static void channel_pad(const float *x, int cin, int hw, int cout, float *out) {
    memcpy(out, x, sizeof(float) * (size_t)cin * (size_t)hw);
    if (cout > cin) {
        memset(out + (size_t)cin * (size_t)hw, 0,
               sizeof(float) * (size_t)(cout - cin) * (size_t)hw);
    }
}

/* Pad input (channels, h, w) on right and bottom by 2 each, zero fill.
 * Output shape: (channels, h+2, w+2). */
static void pad_right_bottom_2(const float *x, int channels, int h, int w, float *out) {
    const int H = h + 2;
    const int W = w + 2;
    memset(out, 0, sizeof(float) * (size_t)channels * (size_t)H * (size_t)W);
    for (int c = 0; c < channels; ++c) {
        const float *xp = x + (size_t)c * (size_t)h * (size_t)w;
        float *op = out + (size_t)c * (size_t)H * (size_t)W;
        for (int yy = 0; yy < h; ++yy) {
            memcpy(op + (size_t)yy * (size_t)W,
                   xp + (size_t)yy * (size_t)w,
                   sizeof(float) * (size_t)w);
        }
    }
}

/* Pad input on left=1, right=2, top=1, bottom=2 with zeros (matches
 * F.pad((1,2,1,2)) used by the BlazeFace stem). */
static void pad_lt1_rb2(const float *x, int channels, int h, int w, float *out) {
    const int H = h + 3;
    const int W = w + 3;
    memset(out, 0, sizeof(float) * (size_t)channels * (size_t)H * (size_t)W);
    for (int c = 0; c < channels; ++c) {
        const float *xp = x + (size_t)c * (size_t)h * (size_t)w;
        float *op = out + (size_t)c * (size_t)H * (size_t)W;
        for (int yy = 0; yy < h; ++yy) {
            memcpy(op + (size_t)(yy + 1) * (size_t)W + 1,
                   xp + (size_t)yy * (size_t)w,
                   sizeof(float) * (size_t)w);
        }
    }
}

static int run_block(const bf_block *b,
                     const float *x, int hin, int win,
                     float **out, int *hout, int *wout)
{
    int H, W;
    float *dw_in;
    int dw_pad_h = 0, dw_pad_w = 0;
    int alloc_in_size = 0;
    float *to_free_dw_in = NULL;

    if (b->stride == 2) {
        /* Pad x on right + bottom by 2; depthwise has stride=2, pad=0,
         * kernel=3 over the (h+2) padded input. */
        const int Hpad = hin + 2;
        const int Wpad = win + 2;
        dw_in = (float *)malloc(sizeof(float) * (size_t)b->cin * (size_t)Hpad * (size_t)Wpad);
        if (!dw_in) return -ENOMEM;
        pad_right_bottom_2(x, b->cin, hin, win, dw_in);
        to_free_dw_in = dw_in;
        H = (Hpad - 3) / 2 + 1;  /* = hin/2 */
        W = (Wpad - 3) / 2 + 1;  /* = win/2 */
        alloc_in_size = b->cin * Hpad * Wpad;
        (void)alloc_in_size;
        (void)dw_pad_h; (void)dw_pad_w;
    } else {
        /* stride=1, pad=1, kernel=3 → output same as input */
        dw_in = (float *)x;
        H = hin;
        W = win;
        dw_pad_h = 1; dw_pad_w = 1;
    }

    /* depthwise */
    float *dw_out = (float *)malloc(sizeof(float) * (size_t)b->cin * (size_t)H * (size_t)W);
    if (!dw_out) { free(to_free_dw_in); return -ENOMEM; }
    if (b->stride == 2) {
        face_depthwise_conv2d_ref(dw_in, b->cin, hin + 2, win + 2,
                                  b->dw_w, 3, 3, b->dw_b,
                                  2, 2, 0, 0, dw_out);
    } else {
        face_depthwise_conv2d_ref(dw_in, b->cin, hin, win,
                                  b->dw_w, 3, 3, b->dw_b,
                                  1, 1, dw_pad_h, dw_pad_w, dw_out);
    }
    free(to_free_dw_in);

    /* pointwise */
    float *pw_out = (float *)malloc(sizeof(float) * (size_t)b->cout * (size_t)H * (size_t)W);
    if (!pw_out) { free(dw_out); return -ENOMEM; }
    face_pointwise_conv2d_ref(dw_out, b->cin, H, W, b->pw_w, b->cout, b->pw_b, pw_out);
    free(dw_out);

    /* residual: maxpool if stride=2, then channel-pad to cout */
    float *res = (float *)malloc(sizeof(float) * (size_t)b->cout * (size_t)H * (size_t)W);
    if (!res) { free(pw_out); return -ENOMEM; }

    if (b->stride == 2) {
        /* MaxPool2d(kernel=2, stride=2) on x → (cin, hin/2, win/2) */
        float *mp = (float *)malloc(sizeof(float) * (size_t)b->cin * (size_t)H * (size_t)W);
        if (!mp) { free(pw_out); free(res); return -ENOMEM; }
        face_maxpool2d_ref(x, b->cin, hin, win, 2, 2, 2, 2, 0, 0, mp);
        channel_pad(mp, b->cin, H * W, b->cout, res);
        free(mp);
    } else {
        channel_pad(x, b->cin, H * W, b->cout, res);
    }

    /* ReLU(pw + res) */
    const int total = b->cout * H * W;
    for (int i = 0; i < total; ++i) {
        float v = pw_out[i] + res[i];
        pw_out[i] = v < 0.0f ? 0.0f : v;
    }
    free(res);

    *out = pw_out;
    *hout = H;
    *wout = W;
    return 0;
}

int face_blazeface_forward(face_blazeface_state *s,
                           const float *chw_input,
                           float *out_regressors,
                           float *out_scores)
{
    if (!s || !chw_input || !out_regressors || !out_scores) return -EINVAL;

    /* F.pad((1, 2, 1, 2)) on the 128x128 input → 131x131. */
    const int Hpad = FACE_DETECTOR_INPUT_SIZE + 3;
    const int Wpad = FACE_DETECTOR_INPUT_SIZE + 3;
    float *padded = (float *)malloc(sizeof(float) * 3 * (size_t)Hpad * (size_t)Wpad);
    if (!padded) return -ENOMEM;
    pad_lt1_rb2(chw_input, 3, FACE_DETECTOR_INPUT_SIZE, FACE_DETECTOR_INPUT_SIZE, padded);

    /* Stem: Conv2d(3, 24, 5, s=2, p=0) on the padded input.
     * Output: H = (131 - 5)/2 + 1 = 64 */
    const int Hs = 64, Ws = 64;
    float *stem = (float *)malloc(sizeof(float) * 24 * (size_t)Hs * (size_t)Ws);
    if (!stem) { free(padded); return -ENOMEM; }
    face_conv2d_ref(padded, 3, Hpad, Wpad, s->stem_w, 24, 5, 5, s->stem_b,
                    2, 2, 0, 0, stem);
    free(padded);
    face_relu_inplace(stem, 24 * Hs * Ws);

    /* backbone1 blocks */
    float *cur = stem;
    int H = Hs, W = Ws;
    for (int i = 0; i < N_BLOCKS_B1; ++i) {
        float *next; int Hn, Wn;
        int rc = run_block(&s->b1[i], cur, H, W, &next, &Hn, &Wn);
        free(cur);
        if (rc) return rc;
        cur = next; H = Hn; W = Wn;
    }
    /* `cur` is now the (88, 16, 16) feature map → x. */
    float *x_feat = cur;
    const int x_h = H, x_w = W;  /* 16 x 16 */

    /* backbone2 blocks (operate on a copy so x_feat survives for cls/reg_8) */
    float *cur2 = (float *)malloc(sizeof(float) * 88 * (size_t)x_h * (size_t)x_w);
    if (!cur2) { free(x_feat); return -ENOMEM; }
    memcpy(cur2, x_feat, sizeof(float) * 88 * (size_t)x_h * (size_t)x_w);
    int H2 = x_h, W2 = x_w;
    for (int i = 0; i < N_BLOCKS_B2; ++i) {
        float *next; int Hn, Wn;
        int rc = run_block(&s->b2[i], cur2, H2, W2, &next, &Hn, &Wn);
        free(cur2);
        if (rc) { free(x_feat); return rc; }
        cur2 = next; H2 = Hn; W2 = Wn;
    }
    /* `cur2` is now the (96, 8, 8) feature map → h. */
    float *h_feat = cur2;
    const int h_h = H2, h_w = W2;  /* 8 x 8 */

    /* Heads. classifier_8 + regressor_8 over x_feat (88ch, 16x16);
     * classifier_16 + regressor_16 over h_feat (96ch, 8x8). */
    float *cls8 = (float *)malloc(sizeof(float) * 2 * (size_t)x_h * (size_t)x_w);
    float *cls16 = (float *)malloc(sizeof(float) * 6 * (size_t)h_h * (size_t)h_w);
    float *reg8 = (float *)malloc(sizeof(float) * 32 * (size_t)x_h * (size_t)x_w);
    float *reg16 = (float *)malloc(sizeof(float) * 96 * (size_t)h_h * (size_t)h_w);
    if (!cls8 || !cls16 || !reg8 || !reg16) {
        free(x_feat); free(h_feat);
        free(cls8); free(cls16); free(reg8); free(reg16);
        return -ENOMEM;
    }

    face_pointwise_conv2d_ref(x_feat, 88, x_h, x_w, s->cls8_w, 2, s->cls8_b, cls8);
    face_pointwise_conv2d_ref(h_feat, 96, h_h, h_w, s->cls16_w, 6, s->cls16_b, cls16);
    face_pointwise_conv2d_ref(x_feat, 88, x_h, x_w, s->reg8_w, 32, s->reg8_b, reg8);
    face_pointwise_conv2d_ref(h_feat, 96, h_h, h_w, s->reg16_w, 96, s->reg16_b, reg16);

    free(x_feat);
    free(h_feat);

    /* Reshape + concat.
     *
     * From the reference:
     *   c1 = classifier_8(x).permute(0,2,3,1).reshape(b, -1, 1)   # (512, 1)
     *   c2 = classifier_16(h).permute(0,2,3,1).reshape(b, -1, 1)  # (384, 1)
     *   c  = cat(c1, c2)                                          # (896, 1)
     *
     *   r1 = regressor_8(x).permute(0,2,3,1).reshape(b, -1, 16)   # (512, 16)
     *   r2 = regressor_16(h).permute(0,2,3,1).reshape(b, -1, 16)  # (384, 16)
     *   r  = cat(r1, r2)                                          # (896, 16)
     *
     * Anchor ordering on a single (h, w, anchors_per_cell) grid:
     *   for y in 0..H: for x in 0..W: for a in 0..A: anchor[y*W*A + x*A + a]
     *
     * NCHW source layout:
     *   c1[c, y, x] where c in [0, 2) = anchors_per_cell at stride 8
     *   permute (2,3,1) → (y, x, c) → flat (y*W*A + x*A + c)
     *
     * So scores[anchor_idx_8] = cls8[c, y, x] with y=anchor_idx_8 / (W*A),
     * x=(anchor_idx_8 / A) % W, c=anchor_idx_8 % A.
     */
    {
        const int A8 = 2;
        for (int y = 0; y < x_h; ++y) {
            for (int x = 0; x < x_w; ++x) {
                for (int a = 0; a < A8; ++a) {
                    const int anchor_idx = (y * x_w + x) * A8 + a;
                    out_scores[anchor_idx] =
                        cls8[((size_t)a * (size_t)x_h + (size_t)y) * (size_t)x_w + (size_t)x];
                    /* regressor: 16 floats per anchor, stored in the
                     * 32-channel output as channels [a*16, (a+1)*16). */
                    for (int k = 0; k < 16; ++k) {
                        const int ch = a * 16 + k;
                        out_regressors[anchor_idx * 16 + k] =
                            reg8[((size_t)ch * (size_t)x_h + (size_t)y) * (size_t)x_w + (size_t)x];
                    }
                }
            }
        }
        const int n8 = x_h * x_w * A8;  /* 512 */

        const int A16 = 6;
        for (int y = 0; y < h_h; ++y) {
            for (int x = 0; x < h_w; ++x) {
                for (int a = 0; a < A16; ++a) {
                    const int anchor_idx = n8 + (y * h_w + x) * A16 + a;
                    out_scores[anchor_idx] =
                        cls16[((size_t)a * (size_t)h_h + (size_t)y) * (size_t)h_w + (size_t)x];
                    for (int k = 0; k < 16; ++k) {
                        const int ch = a * 16 + k;
                        out_regressors[anchor_idx * 16 + k] =
                            reg16[((size_t)ch * (size_t)h_h + (size_t)y) * (size_t)h_w + (size_t)x];
                    }
                }
            }
        }
    }

    free(cls8); free(cls16); free(reg8); free(reg16);
    return 0;
}
