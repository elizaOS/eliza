// doctr_rec.cpp — recognition forward pass (crnn_mobilenet_v3_small + BiLSTM).
//
// Same scaffolding rationale as doctr_det.cpp: API + graph structure are
// pinned; the ggml-backed loader/forward is gated behind DOCTR_HAVE_GGML and
// will be wired once the GGUF weight files exist.

#include "doctr.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#if defined(DOCTR_HAVE_GGML)
#  include "ggml.h"
#  include "ggml-backend.h"
#endif

struct doctr_rec_ctx {
    std::string gguf_path;
    std::string charset;        // utf-8, newline separated
    int charset_size = 0;       // number of glyph entries (charset_size+1 logits)

    int input_h = 32;
    int input_w = 128;          // dynamic; this is the maximum
    float mean[3] = {0.694f, 0.695f, 0.693f};
    float std_[3] = {0.299f, 0.296f, 0.301f};

#if defined(DOCTR_HAVE_GGML)
    struct ggml_context  * gctx    = nullptr;
    ggml_backend_t         backend = nullptr;
    struct ggml_cgraph   * graph   = nullptr;
#endif
};

extern "C" doctr_rec_ctx * doctr_rec_init(const char * gguf_path) {
    if (!gguf_path) return nullptr;
    auto * ctx = new (std::nothrow) doctr_rec_ctx();
    if (!ctx) return nullptr;
    ctx->gguf_path = gguf_path;

#if defined(DOCTR_HAVE_GGML)
    // 1. Open GGUF, validate `doctr.rec.variant == crnn_mobilenet_v3_small`.
    // 2. Read mean/std/input_h/input_w and charset KV.
    // 3. Pick backend.
    // 4. Load conv/bn/linear + LSTM gate weights.
    fprintf(stderr,
            "[doctr_rec] init called for %s — GGML path not yet wired; weights must be built first.\n",
            gguf_path);
    delete ctx;
    return nullptr;
#else
    fprintf(stderr,
            "[doctr_rec] built without DOCTR_HAVE_GGML — weights cannot load.\n");
    delete ctx;
    return nullptr;
#endif
}

extern "C" int doctr_rec_run(doctr_rec_ctx * ctx,
                             const float * rgb_chw,
                             int h, int w,
                             float * out_logits,
                             int * out_T, int * out_C) {
    if (!ctx || !rgb_chw || !out_logits || !out_T || !out_C) {
        return DOCTR_ERR_SHAPE;
    }
    if (h != ctx->input_h) return DOCTR_ERR_SHAPE;
    if (w <= 0 || w > ctx->input_w) return DOCTR_ERR_SHAPE;

#if defined(DOCTR_HAVE_GGML)
    // Forward pass:
    //   1. normalize input with mean/std
    //   2. mobilenetv3-small backbone — outputs (1, 256, 1, w/8)
    //   3. squeeze height -> (1, 256, w/8)
    //   4. BiLSTM 128 hidden × 2 layers
    //   5. linear projection to (charset_size + 1)
    //
    // Output: (T, C) row-major float32 logits.
    *out_T = w / 8;
    *out_C = ctx->charset_size + 1;
    std::memset(out_logits, 0, sizeof(float) * (*out_T) * (*out_C));
    return DOCTR_ERR_BACKEND;
#else
    *out_T = 0;
    *out_C = 0;
    return DOCTR_ERR_BACKEND;
#endif
}

extern "C" const char * doctr_rec_charset(doctr_rec_ctx * ctx) {
    return ctx ? ctx->charset.c_str() : nullptr;
}

extern "C" void doctr_rec_free(doctr_rec_ctx * ctx) {
    if (!ctx) return;
#if defined(DOCTR_HAVE_GGML)
    if (ctx->gctx)    { ggml_free(ctx->gctx); }
    if (ctx->backend) { ggml_backend_free(ctx->backend); }
#endif
    delete ctx;
}
