/*
 * face-cpp — public C ABI for the standalone native plugin that ports
 * BlazeFace detection + a 128-d face-embedding network to the
 * elizaOS/llama.cpp fork's ggml dispatcher. Replaces the ONNX-backed
 * MediaPipe face detector and the face-api.js recognition pipeline in
 * plugin-vision (`face-detector-mediapipe.ts`, `face-recognition.ts`).
 *
 * Two heads are exposed:
 *
 *   1. BlazeFace (front, 128x128) — SSD-style single-shot detector with
 *      6-keypoint regression. Two anchor strides (8 and 16) yield 896
 *      anchors total. See:
 *        Bazarevsky et al., "BlazeFace: Sub-millisecond Neural Face
 *        Detection on Mobile GPUs", arXiv:1907.05047.
 *      Upstream weights:
 *        https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_detection/face_detection_front.tflite
 *
 *   2. 128-d face embedding network (FaceNet-style or ArcFace-mini) —
 *      input is a 112x112 RGB face crop aligned via the BlazeFace
 *      keypoints (5-of-6 used: left eye, right eye, nose tip, mouth-left,
 *      mouth-right). Output is an L2-normalized 128-d vector.
 *      Upstream weights:
 *        https://github.com/deepinsight/insightface (buffalo_s) or
 *        https://github.com/timesler/facenet-pytorch (facenet 128d).
 *
 * Coordinate convention: every detection bbox is `{x, y, w, h}` in
 * source-image absolute pixel coordinates; `(x, y)` is the bbox top-left.
 * The keypoint vector packs 6 (x, y) pairs in the BlazeFace order:
 *   [0,1]   left eye
 *   [2,3]   right eye
 *   [4,5]   nose tip
 *   [6,7]   mouth (centre / lip)
 *   [8,9]   left ear tragion
 *   [10,11] right ear tragion
 *
 * Threading: every entry point is reentrant against distinct handles.
 * Sharing one handle across threads requires the caller's own mutex.
 *
 * Error handling: all entry points return `int` — zero on success,
 * negative `errno`-style codes on failure. The stub returns `-ENOSYS`.
 */

#ifndef FACE_FACE_H
#define FACE_FACE_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Pinned model variants this header is dimensioned around. The GGUF
 * conversion scripts (`scripts/blazeface_to_gguf.py`,
 * `scripts/face_embed_to_gguf.py`) emit artifacts that declare these
 * as their `face.detector` / `face.embedder` keys. Loaders refuse a
 * GGUF whose tag does not match. */
#define FACE_DETECTOR_BLAZEFACE_FRONT  "blazeface_front"
#define FACE_EMBEDDER_FACENET_128      "facenet_128"
#define FACE_EMBEDDER_ARCFACE_MINI_128 "arcface_mini_128"

/* BlazeFace front model is dimensioned around a 128x128 RGB input. */
#define FACE_DETECTOR_INPUT_SIZE       128

/* Anchor count for the BlazeFace front model: two strides (8, 16) on a
 * 128x128 input grid, with (2, 6) anchors per cell respectively:
 *   (128/8)^2  * 2 = 256 * 2 = 512
 *   (128/16)^2 * 6 = 64  * 6 = 384
 *   total                     = 896
 * The anchor decoder in `src/face_anchor_decode.c` produces exactly
 * this many anchors. */
#define FACE_DETECTOR_ANCHOR_COUNT     896

/* 6 keypoints per detection, packed as (x, y) pairs. */
#define FACE_DETECTOR_KEYPOINT_COUNT   6
#define FACE_DETECTOR_KEYPOINT_FLOATS  (FACE_DETECTOR_KEYPOINT_COUNT * 2)

/* Aligned crop dimensions used by both the embedding network and the
 * affine-warp helper (`src/face_align.c`). Standard for ArcFace /
 * FaceNet small variants. */
#define FACE_EMBED_CROP_SIZE           112

/* Embedding dimensionality. Both supported embedders emit 128-d L2
 * normalized vectors. */
#define FACE_EMBED_DIM                 128

/*
 * Detection record. Coordinates are in source-image absolute pixels;
 * `(x, y)` is the bbox top-left and `(w, h)` are the bbox dimensions.
 * `confidence` is the post-sigmoid score in [0, 1]. `landmarks` packs
 * 6 (x, y) keypoint coordinates in source-image absolute pixels, in
 * the BlazeFace order documented at the top of this header.
 */
typedef struct face_detection {
    float x;
    float y;
    float w;
    float h;
    float confidence;
    float landmarks[FACE_DETECTOR_KEYPOINT_FLOATS];
} face_detection;

/* Opaque handles for each loaded model. */
typedef struct face_detect_session  *face_detect_handle;
typedef struct face_embed_session   *face_embed_handle;

/* ---------------- detection ---------------- */

/*
 * Open a BlazeFace session against a GGUF produced by
 * `scripts/blazeface_to_gguf.py`. The GGUF must declare its
 * `face.detector` key as FACE_DETECTOR_BLAZEFACE_FRONT. Returns 0 on
 * success and writes the new handle into `*out`. Returns `-ENOSYS`
 * from the stub, `-ENOENT` for missing GGUF, `-EINVAL` for shape /
 * version mismatch.
 */
int face_detect_open(const char *gguf_path, face_detect_handle *out);

/*
 * Run detection over a contiguous RGB plane. `stride` is the byte
 * distance between consecutive rows; for tightly packed images that is
 * `w * 3`. Allowing a separate stride lets callers feed sub-rectangles
 * of a larger frame buffer without copy.
 *
 *   - `conf` filters candidates by post-sigmoid score before NMS
 *     (e.g. 0.5).
 *
 * The library writes up to `cap` detections into `out` and the actual
 * count into `*count`. Returns 0 on success, `-ENOSPC` if the buffer
 * was too small for the detected box count (the caller should re-call
 * with a bigger buffer; `*count` then carries the required size).
 */
int face_detect(face_detect_handle handle,
                const uint8_t *rgb,
                int w,
                int h,
                int stride,
                float conf,
                face_detection *out,
                size_t cap,
                size_t *count);

/* Release a session. Returns 0 on success. Safe with NULL. */
int face_detect_close(face_detect_handle handle);

/* ---------------- recognition ---------------- */

/*
 * Open a face-embedding session against a GGUF produced by
 * `scripts/face_embed_to_gguf.py`. The GGUF must declare its
 * `face.embedder` key as one of FACE_EMBEDDER_FACENET_128 /
 * FACE_EMBEDDER_ARCFACE_MINI_128. Returns 0 on success and writes the
 * new handle into `*out`. Stub returns `-ENOSYS`.
 */
int face_embed_open(const char *gguf_path, face_embed_handle *out);

/*
 * Compute a 128-d L2-normalized embedding for a single face crop.
 *
 *   - `rgb`, `w`, `h`, `stride` describe the source RGB image.
 *   - `crop` is the detection record whose bbox + landmarks identify
 *     the face. The embedder uses the 5 alignment keypoints (eyes,
 *     nose, mouth corners) to build a 112x112 affine-warped crop via
 *     `face_align.c` before running the embedding network.
 *   - `embedding_out` must point to a buffer of FACE_EMBED_DIM (128)
 *     floats. The library writes the L2-normalized embedding there.
 *
 * Returns 0 on success, `-EINVAL` for null inputs or zero-area crop,
 * `-ENOSYS` from the stub.
 */
int face_embed(face_embed_handle handle,
               const uint8_t *rgb,
               int w,
               int h,
               int stride,
               const face_detection *crop,
               float *embedding_out);

/* Release an embedding session. Returns 0 on success. Safe with NULL. */
int face_embed_close(face_embed_handle handle);

/*
 * Cosine distance between two 128-d face embeddings. Real
 * implementation in `src/face_distance.c`. Returns a value in
 * [0, 2]: 0 for identical (post-normalization) vectors, 1 for
 * orthogonal, 2 for antipodal.
 *
 * The function assumes both inputs are already L2-normalized (which is
 * what `face_embed` produces). It does NOT re-normalize; if the caller
 * stores raw un-normalized embeddings, normalize before calling.
 */
float face_embed_distance(const float *a, const float *b);

/* L2 distance variant. Same assumptions; returns a value in [0, 2]
 * for unit-norm inputs. */
float face_embed_distance_l2(const float *a, const float *b);

/* ---------------- anchors ---------------- */

/* BlazeFace anchor record in normalized [0, 1] coordinates. Generated
 * by `face_blazeface_make_anchors`. The anchor table is keyed only on
 * the input dimension and the (stride, anchors-per-cell) schedule;
 * since we lock the front model at 128x128, the table is constant per
 * model and can be precomputed once at load time. */
typedef struct face_blazeface_anchor {
    float x_center;
    float y_center;
    float w;
    float h;
} face_blazeface_anchor;

/*
 * Generate the BlazeFace front-model anchor table. Writes
 * `FACE_DETECTOR_ANCHOR_COUNT` anchors into `out`. Returns the number
 * of anchors written, or a negative errno on shape mismatch.
 *
 * The schedule (matches mediapipe/modules/face_detection/face_detection_front.pbtxt):
 *   stride 8,  anchors_per_cell = 2 → 16x16 grid → 512 anchors
 *   stride 16, anchors_per_cell = 6 → 8x8 grid   → 384 anchors
 *
 * Each anchor's (x_center, y_center, w, h) is in normalized [0, 1]
 * coordinates relative to the FACE_DETECTOR_INPUT_SIZE square input.
 * `w` and `h` are 1 by convention for BlazeFace (the regressor learns
 * the actual width/height as offsets).
 */
int face_blazeface_make_anchors(face_blazeface_anchor *out, size_t cap);

/*
 * Decode raw BlazeFace outputs into source-image absolute-pixel
 * detections. Inputs:
 *   - `anchors`: FACE_DETECTOR_ANCHOR_COUNT entries (precomputed via
 *      face_blazeface_make_anchors).
 *   - `regressors`: FACE_DETECTOR_ANCHOR_COUNT * 16 floats (4 bbox
 *      coords + 6 keypoint pairs per anchor) — model output, in
 *      input-pixel coordinates relative to FACE_DETECTOR_INPUT_SIZE.
 *   - `scores`: FACE_DETECTOR_ANCHOR_COUNT pre-sigmoid logits.
 *   - `conf`: post-sigmoid confidence threshold; anchors below this
 *      are discarded.
 *   - `src_w`, `src_h`: source image dimensions (pixels). Detections
 *      are scaled from the 128-pixel input space back to source
 *      pixels.
 *   - `out`, `cap`, `count`: caller-provided detection buffer and
 *      out-count, same convention as `face_detect`.
 *
 * Returns 0 on success, `-ENOSPC` on buffer overflow.
 *
 * NOTE: This function does NOT run NMS — it only decodes. The caller
 * (or `face_detect`) is responsible for IoU-NMS on the returned set.
 */
int face_blazeface_decode(const face_blazeface_anchor *anchors,
                          const float *regressors,
                          const float *scores,
                          float conf,
                          int src_w,
                          int src_h,
                          face_detection *out,
                          size_t cap,
                          size_t *count);

/* ---------------- alignment ---------------- */

/*
 * Affine-warp a face crop into a FACE_EMBED_CROP_SIZE x
 * FACE_EMBED_CROP_SIZE RGB image using 5 of the 6 BlazeFace keypoints
 * (left eye, right eye, nose tip, mouth-left, mouth-right). Bilinear
 * sampling. Pure-C implementation in `src/face_align.c`.
 *
 * Inputs:
 *   - `rgb`, `src_w`, `src_h`, `src_stride`: source RGB plane.
 *   - `det`: detection whose 5-of-6 keypoints anchor the affine.
 *
 * Output:
 *   - `out_rgb`: caller-allocated buffer, size
 *      FACE_EMBED_CROP_SIZE * FACE_EMBED_CROP_SIZE * 3 bytes.
 *
 * Returns 0 on success, `-EINVAL` on null inputs or degenerate
 * keypoints.
 */
int face_align_5pt(const uint8_t *rgb,
                   int src_w,
                   int src_h,
                   int src_stride,
                   const face_detection *det,
                   uint8_t *out_rgb);

/* ---------------- diagnostics ---------------- */

/*
 * Capability string of the active backend, e.g. "ggml-cpu",
 * "ggml-metal", "stub". Reflects the *runtime*-selected path. The
 * stub returns "stub".
 */
const char *face_active_backend(void);

#ifdef __cplusplus
}
#endif

#endif /* FACE_FACE_H */
