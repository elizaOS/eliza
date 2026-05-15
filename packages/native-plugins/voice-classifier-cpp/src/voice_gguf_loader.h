/*
 * voice-classifier-cpp — internal GGUF metadata + tensor loader.
 *
 * Not exported in the public C ABI; consumed only by the per-head TUs
 * inside this library. Each head's `*_open` calls
 * `voice_gguf_load_metadata(path, "voice_<head>", &meta)` and then
 * validates the fields it cares about against its locked contract.
 *
 * The K2 wave extends the loader with tensor enumeration + raw float
 * tensor reads, used by the WeSpeaker ResNet34-LM forward graph
 * (`voice_speaker.c`). Tensor data is read into caller-allocated
 * Float32Array-style buffers; no mmap or fork/libllama dep.
 */

#ifndef VOICE_CLASSIFIER_VOICE_GGUF_LOADER_H
#define VOICE_CLASSIFIER_VOICE_GGUF_LOADER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct voice_gguf_metadata {
    /* GGUF file version (e.g. 3). */
    int gguf_version;
    /* Number of tensors in the file. */
    int tensor_count;
    /* Required audio front-end parameters; locked at 16 kHz / 80 mels /
     * 512 n_fft / 160 hop by the public header. The per-head opener
     * refuses to load if these disagree. Zero if the GGUF didn't set
     * the corresponding key. */
    int sample_rate;
    int n_mels;
    int n_fft;
    int hop;
    /* Output dim (for emotion + diarizer: num classes; for speaker:
     * embedding dim). Per-head opener interprets. Zero if unset. */
    int num_classes;
    int embedding_dim;
    /* Variant identifier (the upstream model id pinned at conversion
     * time). NUL-terminated; truncated to 127 chars. */
    char variant[128];
} voice_gguf_metadata_t;

/* Load the metadata block from a GGUF file at `path`. `prefix` is the
 * key prefix to scan for ("voice_emotion", "voice_speaker",
 * "voice_eot", "voice_diarizer").
 *
 * Returns 0 on success and populates `*out`. Returns:
 *   -ENOENT : file doesn't exist
 *   -EINVAL : bad magic, wrong GGUF version, malformed KV
 *   -ENOMEM : alloc failure
 *
 * On failure `*out` is zeroed. */
int voice_gguf_load_metadata(const char *path,
                             const char *prefix,
                             voice_gguf_metadata_t *out);

/* ---------- Tensor enumeration + load (K2: ResNet34 weights) ---------- */

/* Maximum tensor name length we accept (well above any name we emit). */
#define VOICE_GGUF_MAX_TENSOR_NAME 128

/* Per-tensor descriptor produced by `voice_gguf_open_tensors`. */
typedef struct voice_gguf_tensor_desc {
    char name[VOICE_GGUF_MAX_TENSOR_NAME];
    int ndim;
    int64_t dims[4];     /* GGML order: fastest dim first. */
    int ggml_type;        /* 0 = fp32, 1 = fp16, etc. */
    int64_t n_elements;
    int64_t data_offset; /* absolute file offset of tensor data */
    int64_t n_bytes;     /* total bytes of tensor data */
} voice_gguf_tensor_desc_t;

/* Opaque "bundle" struct created by `voice_gguf_open_tensors` and
 * destroyed by `voice_gguf_close_tensors`. Owns the open file plus the
 * tensor descriptor array. */
typedef struct voice_gguf_bundle voice_gguf_bundle_t;

/* Open a GGUF file at `path`, parse metadata + tensor descriptors, and
 * leave the file open for subsequent tensor data reads.
 *
 * Returns 0 on success and writes the bundle pointer to `*out`. Returns:
 *   -ENOENT : file doesn't exist
 *   -EINVAL : bad magic / wrong version / malformed metadata
 *   -ENOMEM : alloc failure
 *
 * On failure `*out` is set to NULL.
 */
int voice_gguf_open_tensors(const char *path,
                            const char *prefix,
                            voice_gguf_metadata_t *meta_out,
                            voice_gguf_bundle_t **out);

/* Number of tensor descriptors in the bundle. */
int voice_gguf_tensor_count(const voice_gguf_bundle_t *b);

/* Pointer to the n-th tensor descriptor (0-based, < tensor_count). */
const voice_gguf_tensor_desc_t *voice_gguf_tensor_at(
    const voice_gguf_bundle_t *b, int idx);

/* Find a tensor by name. Returns NULL when not found. */
const voice_gguf_tensor_desc_t *voice_gguf_tensor_find(
    const voice_gguf_bundle_t *b, const char *name);

/* Read a fp32 tensor by name into the caller's buffer. `dst_capacity`
 * must be >= the tensor's element count.
 *
 * Returns 0 on success, -EINVAL on missing tensor / wrong type, -ENOSPC
 * when the buffer is too small, or a negative errno from the I/O.
 *
 * Only fp32 is supported in K2; fp16 / quantized tensors return
 * -EINVAL with a future-compat-friendly contract.
 */
int voice_gguf_read_tensor_f32(const voice_gguf_bundle_t *b,
                               const char *name,
                               float *dst,
                               size_t dst_capacity);

/* Close the bundle and release all owned state. NULL-safe. */
void voice_gguf_close_tensors(voice_gguf_bundle_t *b);

#ifdef __cplusplus
}
#endif

#endif /* VOICE_CLASSIFIER_VOICE_GGUF_LOADER_H */
