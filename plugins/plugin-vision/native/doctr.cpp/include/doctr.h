// doctr.h — C ABI for the ggml-backed doCTR runtime.
//
// Stable across detection / recognition variants. Both variants own their own
// context; they're built around ggml's compute-graph + GGUF weight loader and
// expose only the forward pass. Post-processing (DBNet contouring, CTC decode)
// happens in TypeScript so that the C side stays a pure tensor pipeline.
//
// Threading model: each context is single-threaded. Callers wanting parallel
// recognition over multiple crops should hold a pool of contexts.

#ifndef DOCTR_H
#define DOCTR_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct doctr_det_ctx doctr_det_ctx;
typedef struct doctr_rec_ctx doctr_rec_ctx;

// Return codes. Anything non-zero is an error.
#define DOCTR_OK              0
#define DOCTR_ERR_FILE       -1
#define DOCTR_ERR_FORMAT     -2
#define DOCTR_ERR_OOM        -3
#define DOCTR_ERR_SHAPE      -4
#define DOCTR_ERR_BACKEND    -5

// === Detection ===
//
// Loads a `db_mobilenet_v3_large`-based detection model from GGUF. Expected
// metadata KV entries:
//   - "doctr.det.variant"   = "db_mobilenet_v3_large"
//   - "doctr.det.mean"      = float[3]   (per-channel RGB mean, 0..1)
//   - "doctr.det.std"       = float[3]   (per-channel RGB std, 0..1)
//   - "doctr.det.input_h"   = int        (typical 1024)
//   - "doctr.det.input_w"   = int        (typical 1024)
//
// Returns NULL on failure; check stderr for diagnostics.
doctr_det_ctx * doctr_det_init(const char * gguf_path);

// rgb_chw: CHW float32 RGB, normalized externally to [0,1] (the C side
// applies the model's mean/std from GGUF metadata).
// h, w: spatial dims of rgb_chw. Must match the GGUF input_h/input_w
// (callers letterbox/resize beforehand).
// out_prob: caller-allocated. Size must be (h/4) * (w/4) float32.
// out_h, out_w: filled with the actual probability-map dims (h/4, w/4).
int doctr_det_run(doctr_det_ctx * ctx,
                  const float * rgb_chw,
                  int h, int w,
                  float * out_prob,
                  int * out_h, int * out_w);

void doctr_det_free(doctr_det_ctx * ctx);

// === Recognition ===
//
// Loads a `crnn_mobilenet_v3_small`-based recognition model. Expected GGUF
// metadata:
//   - "doctr.rec.variant"   = "crnn_mobilenet_v3_small"
//   - "doctr.rec.mean"      = float[3]
//   - "doctr.rec.std"       = float[3]
//   - "doctr.rec.input_h"   = int       (typical 32)
//   - "doctr.rec.input_w"   = int       (typical 128)
//   - "doctr.rec.charset"   = utf8 string (newline-separated)
doctr_rec_ctx * doctr_rec_init(const char * gguf_path);

// rgb_chw: CHW float32 RGB crop normalized to [0,1].
// h must equal input_h (32). w is dynamic up to model max.
// out_logits: caller-allocated. Size must be at least T * C float32
// where T = w/8 (typical CRNN stride) and C = charset.size()+1.
// out_T, out_C: written by the call.
int doctr_rec_run(doctr_rec_ctx * ctx,
                  const float * rgb_chw,
                  int h, int w,
                  float * out_logits,
                  int * out_T, int * out_C);

// Returns the embedded UTF-8 charset string (newline-separated, owned by ctx).
const char * doctr_rec_charset(doctr_rec_ctx * ctx);

void doctr_rec_free(doctr_rec_ctx * ctx);

#ifdef __cplusplus
}
#endif

#endif // DOCTR_H
