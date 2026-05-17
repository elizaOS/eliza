/*
 * face_embed.c — face embedding network forward pass.
 *
 * The C ABI advertises two embedder families
 * (FACE_EMBEDDER_FACENET_128 / FACE_EMBEDDER_ARCFACE_MINI_128). Both
 * produce L2-normalized 128-d embeddings on a 112×112 RGB face crop.
 *
 * For the first cut we ship a single small-MobileFaceNet-style
 * architecture and tag it as `facenet_128`. The architecture is
 * defined here AND in `scripts/face_embed_to_gguf.py` — the converter
 * builds a torch model with the matching topology, optionally pulls
 * pretrained weights from facenet-pytorch's InceptionResnetV1 head,
 * projects them down to 128-d via a fixed orthonormal matrix, and
 * dumps each layer's weights into the GGUF.
 *
 * Architecture (in order):
 *
 *   Input: (3, 112, 112), normalized as (x/127.5 - 1) per channel.
 *
 *   stem:       Conv2d(3, 32, 3, s=2, p=1) + ReLU         → (32, 56, 56)
 *
 *   block1:     Depthwise(32, k=3, s=1, p=1) + ReLU
 *               Pointwise(32 → 64) + ReLU                  → (64, 56, 56)
 *
 *   block2:     Depthwise(64, k=3, s=2, p=1) + ReLU
 *               Pointwise(64 → 128) + ReLU                 → (128, 28, 28)
 *
 *   block3:     Depthwise(128, k=3, s=1, p=1) + ReLU
 *               Pointwise(128 → 128) + ReLU                → (128, 28, 28)
 *
 *   block4:     Depthwise(128, k=3, s=2, p=1) + ReLU
 *               Pointwise(128 → 256) + ReLU                → (256, 14, 14)
 *
 *   block5:     Depthwise(256, k=3, s=2, p=1) + ReLU
 *               Pointwise(256 → 256) + ReLU                → (256, 7, 7)
 *
 *   gap:        Global average pool                        → (256,)
 *   proj:       Linear(256 → 128)                          → (128,)
 *   l2 norm:    x / ||x||_2                                → (128,)
 *
 * GGUF tensor naming (matches the keys produced by
 * scripts/face_embed_to_gguf.py):
 *
 *   emb.stem.weight                (32, 3, 3, 3)
 *   emb.stem.bias                  (32,)
 *   emb.block{1..5}.dw.weight      (cin, 1, 3, 3)
 *   emb.block{1..5}.dw.bias        (cin,)
 *   emb.block{1..5}.pw.weight      (cout, cin, 1, 1)
 *   emb.block{1..5}.pw.bias        (cout,)
 *   emb.proj.weight                (128, 256)
 *   emb.proj.bias                  (128,)
 */

#include "face_internal.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EMBED_TENSOR_DIMS 4

typedef struct {
    int cin;
    int cout;
    int stride;  /* 1 or 2 (depthwise stride) */
    const float *dw_w;  float *dw_w_owned;
    const float *dw_b;  float *dw_b_owned;
    const float *pw_w;  float *pw_w_owned;
    const float *pw_b;  float *pw_b_owned;
} embed_block;

#define N_EMBED_BLOCKS 5
static const struct {
    int cin;
    int cout;
    int stride;
} EMBED_BLOCKS[N_EMBED_BLOCKS] = {
    {  32,  64, 1 },  /* block1 */
    {  64, 128, 2 },  /* block2 */
    { 128, 128, 1 },  /* block3 */
    { 128, 256, 2 },  /* block4 */
    { 256, 256, 2 },  /* block5 */
};

struct face_embed_state {
    const float *stem_w; float *stem_w_owned;
    const float *stem_b; float *stem_b_owned;
    embed_block blocks[N_EMBED_BLOCKS];
    const float *proj_w; float *proj_w_owned;
    const float *proj_b; float *proj_b_owned;
};

static const float *EMBT(const face_gguf *g, const char *name,
                         int64_t *dims, int *ndim, float **owned)
{
    return face_gguf_get_f32_view(g, name, dims, EMBED_TENSOR_DIMS, ndim, owned);
}

static int load_embed_block(const face_gguf *g, const char *prefix,
                            int cin, int cout, int stride,
                            embed_block *out)
{
    char buf[128];
    int64_t dims[4]; int nd;

    snprintf(buf, sizeof buf, "%s.dw.weight", prefix);
    out->dw_w = EMBT(g, buf, dims, &nd, &out->dw_w_owned);
    if (!out->dw_w || nd != 4 || dims[0] != cin || dims[1] != 1
        || dims[2] != 3 || dims[3] != 3) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.dw.bias", prefix);
    out->dw_b = EMBT(g, buf, dims, &nd, &out->dw_b_owned);
    if (!out->dw_b || nd != 1 || dims[0] != cin) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.pw.weight", prefix);
    out->pw_w = EMBT(g, buf, dims, &nd, &out->pw_w_owned);
    if (!out->pw_w || nd != 4 || dims[0] != cout || dims[1] != cin
        || dims[2] != 1 || dims[3] != 1) return -EINVAL;

    snprintf(buf, sizeof buf, "%s.pw.bias", prefix);
    out->pw_b = EMBT(g, buf, dims, &nd, &out->pw_b_owned);
    if (!out->pw_b || nd != 1 || dims[0] != cout) return -EINVAL;

    out->cin = cin; out->cout = cout; out->stride = stride;
    return 0;
}

face_embed_state *face_embed_state_new(const face_gguf *g, int *err) {
    if (err) *err = 0;
    face_embed_state *s = (face_embed_state *)calloc(1, sizeof(*s));
    if (!s) { if (err) *err = -ENOMEM; return NULL; }

    int rc;
    int64_t dims[4]; int nd;
    char buf[160];

    s->stem_w = EMBT(g, "emb.stem.weight", dims, &nd, &s->stem_w_owned);
    if (!s->stem_w || nd != 4 || dims[0] != 32 || dims[1] != 3
        || dims[2] != 3 || dims[3] != 3) { rc = -EINVAL; goto fail; }
    s->stem_b = EMBT(g, "emb.stem.bias", dims, &nd, &s->stem_b_owned);
    if (!s->stem_b || nd != 1 || dims[0] != 32) { rc = -EINVAL; goto fail; }

    for (int i = 0; i < N_EMBED_BLOCKS; ++i) {
        snprintf(buf, sizeof buf, "emb.block%d", i + 1);
        rc = load_embed_block(g, buf,
                              EMBED_BLOCKS[i].cin,
                              EMBED_BLOCKS[i].cout,
                              EMBED_BLOCKS[i].stride,
                              &s->blocks[i]);
        if (rc) goto fail;
    }

    s->proj_w = EMBT(g, "emb.proj.weight", dims, &nd, &s->proj_w_owned);
    if (!s->proj_w || nd != 2 || dims[0] != FACE_EMBED_DIM || dims[1] != 256) {
        rc = -EINVAL; goto fail;
    }
    s->proj_b = EMBT(g, "emb.proj.bias", dims, &nd, &s->proj_b_owned);
    if (!s->proj_b || nd != 1 || dims[0] != FACE_EMBED_DIM) {
        rc = -EINVAL; goto fail;
    }

    return s;

fail:
    if (err) *err = rc;
    face_embed_state_free(s);
    return NULL;
}

void face_embed_state_free(face_embed_state *s) {
    if (!s) return;
    free(s->stem_w_owned);
    free(s->stem_b_owned);
    for (int i = 0; i < N_EMBED_BLOCKS; ++i) {
        free(s->blocks[i].dw_w_owned);
        free(s->blocks[i].dw_b_owned);
        free(s->blocks[i].pw_w_owned);
        free(s->blocks[i].pw_b_owned);
    }
    free(s->proj_w_owned);
    free(s->proj_b_owned);
    free(s);
}

static int run_embed_block(const embed_block *b,
                           const float *x, int hin, int win,
                           float **out, int *hout, int *wout)
{
    const int H = (hin + 2 - 3) / b->stride + 1;
    const int W = (win + 2 - 3) / b->stride + 1;
    float *dw_out = (float *)malloc(sizeof(float) * (size_t)b->cin * (size_t)H * (size_t)W);
    if (!dw_out) return -ENOMEM;
    face_depthwise_conv2d_ref(x, b->cin, hin, win, b->dw_w, 3, 3, b->dw_b,
                              b->stride, b->stride, 1, 1, dw_out);
    face_relu_inplace(dw_out, b->cin * H * W);

    float *pw_out = (float *)malloc(sizeof(float) * (size_t)b->cout * (size_t)H * (size_t)W);
    if (!pw_out) { free(dw_out); return -ENOMEM; }
    face_pointwise_conv2d_ref(dw_out, b->cin, H, W, b->pw_w, b->cout, b->pw_b, pw_out);
    free(dw_out);
    face_relu_inplace(pw_out, b->cout * H * W);

    *out = pw_out;
    *hout = H;
    *wout = W;
    return 0;
}

int face_embed_forward(face_embed_state *s,
                       const float *chw_input,
                       float *embedding_out)
{
    if (!s || !chw_input || !embedding_out) return -EINVAL;

    const int Hin = FACE_EMBED_CROP_SIZE;
    const int Win = FACE_EMBED_CROP_SIZE;

    /* stem: Conv2d(3, 32, 3, s=2, p=1) + ReLU */
    const int Hs = (Hin + 2 - 3) / 2 + 1;  /* 56 */
    const int Ws = (Win + 2 - 3) / 2 + 1;  /* 56 */
    float *cur = (float *)malloc(sizeof(float) * 32 * (size_t)Hs * (size_t)Ws);
    if (!cur) return -ENOMEM;
    face_conv2d_ref(chw_input, 3, Hin, Win, s->stem_w, 32, 3, 3, s->stem_b,
                    2, 2, 1, 1, cur);
    face_relu_inplace(cur, 32 * Hs * Ws);
    int H = Hs, W = Ws;

    for (int i = 0; i < N_EMBED_BLOCKS; ++i) {
        float *next; int Hn, Wn;
        int rc = run_embed_block(&s->blocks[i], cur, H, W, &next, &Hn, &Wn);
        free(cur);
        if (rc) return rc;
        cur = next; H = Hn; W = Wn;
    }
    /* cur is (256, 7, 7) at the end of block5. */
    const int last_c = 256;

    /* Global average pool */
    float gap[256];
    for (int c = 0; c < last_c; ++c) {
        float sum = 0.0f;
        const float *p = cur + (size_t)c * (size_t)H * (size_t)W;
        for (int i = 0; i < H * W; ++i) sum += p[i];
        gap[c] = sum / (float)(H * W);
    }
    free(cur);

    /* Linear projection to 128-d, then L2 normalize. */
    face_linear_ref(gap, 1, last_c, s->proj_w, FACE_EMBED_DIM, s->proj_b, embedding_out);
    face_l2_normalize_inplace(embedding_out, FACE_EMBED_DIM);

    return 0;
}
