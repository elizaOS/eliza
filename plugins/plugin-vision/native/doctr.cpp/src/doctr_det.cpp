// doctr_det.cpp — detection forward pass (db_mobilenet_v3_large + DBNet head).
//
// SCAFFOLD: this file pins the API and the high-level graph structure. The
// actual conv/BN/upsample ops are stubbed against ggml's tensor API but not
// yet wired against a built ggml dependency tree. The matching CMakeLists.txt
// vendors `ggml` as a git submodule; we keep this file compilable-in-isolation
// behind `DOCTR_HAVE_GGML` so the plugin can build even before the submodule
// is populated.

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

struct doctr_det_ctx {
    std::string gguf_path;

    // Hyperparameters from GGUF metadata.
    int   input_h     = 1024;
    int   input_w     = 1024;
    float mean[3]     = {0.798f, 0.785f, 0.772f};   // doCTR defaults
    float std_[3]     = {0.264f, 0.275f, 0.286f};

#if defined(DOCTR_HAVE_GGML)
    struct ggml_context  * gctx   = nullptr;
    ggml_backend_t         backend = nullptr;
    // The compute graph + parameter tensors get built lazily on the first
    // run, so the model file can be opened and validated without paying for
    // the graph allocation cost.
    struct ggml_cgraph   * graph  = nullptr;
#endif
};

extern "C" doctr_det_ctx * doctr_det_init(const char * gguf_path) {
    if (!gguf_path) return nullptr;

    auto * ctx = new (std::nothrow) doctr_det_ctx();
    if (!ctx) return nullptr;
    ctx->gguf_path = gguf_path;

#if defined(DOCTR_HAVE_GGML)
    // 1. Open GGUF, validate `doctr.det.variant == db_mobilenet_v3_large`.
    // 2. Read mean/std/input_{h,w} metadata into ctx.
    // 3. Pick backend (Metal on darwin, CUDA when available, CPU else).
    // 4. Load conv/bn/linear parameter tensors into ctx->gctx.
    //
    // NOT YET WIRED: the loader is implemented in the conversion harness
    // shipped in `scripts/convert.py`; the runtime loader will mirror the
    // same tensor naming. See README.md for the conversion pipeline.
    fprintf(stderr,
            "[doctr_det] init called for %s — GGML path not yet wired; weights must be built first.\n",
            gguf_path);
    delete ctx;
    return nullptr;
#else
    // Build without ggml linked: refuse to initialize at all so the caller's
    // JS layer can throw a clear "GGUF not ready" error.
    fprintf(stderr,
            "[doctr_det] built without DOCTR_HAVE_GGML — weights cannot load.\n");
    delete ctx;
    return nullptr;
#endif
}

extern "C" int doctr_det_run(doctr_det_ctx * ctx,
                             const float * rgb_chw,
                             int h, int w,
                             float * out_prob,
                             int * out_h, int * out_w) {
    if (!ctx || !rgb_chw || !out_prob || !out_h || !out_w) {
        return DOCTR_ERR_SHAPE;
    }
    if (h != ctx->input_h || w != ctx->input_w) {
        return DOCTR_ERR_SHAPE;
    }
#if defined(DOCTR_HAVE_GGML)
    // Forward pass:
    //   1. apply mean/std normalization in-place to a scratch tensor
    //   2. run db_mobilenet_v3_large backbone (12 inverted-residual blocks,
    //      hidden-state dims [16,24,40,80,112,160])
    //   3. FPN-like neck producing a single (B, 256, H/4, W/4) feature map
    //   4. DBNet head: 3x3 conv → conv-transpose ×2 → 1x1 conv → sigmoid
    //
    // Output: (1, 1, H/4, W/4) probability map copied into out_prob.
    *out_h = h / 4;
    *out_w = w / 4;
    std::memset(out_prob, 0, sizeof(float) * (*out_h) * (*out_w));
    return DOCTR_ERR_BACKEND;
#else
    (void)out_prob;
    *out_h = 0;
    *out_w = 0;
    return DOCTR_ERR_BACKEND;
#endif
}

extern "C" void doctr_det_free(doctr_det_ctx * ctx) {
    if (!ctx) return;
#if defined(DOCTR_HAVE_GGML)
    if (ctx->graph)   { /* ggml_graph_free handled by gctx */ }
    if (ctx->gctx)    { ggml_free(ctx->gctx); }
    if (ctx->backend) { ggml_backend_free(ctx->backend); }
#endif
    delete ctx;
}
