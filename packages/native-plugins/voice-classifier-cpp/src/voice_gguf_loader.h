/*
 * voice-classifier-cpp — internal GGUF metadata + tensor loader.
 *
 * Not exported in the public C ABI; consumed only by the per-head TUs
 * inside this library. Each head's `*_open` calls
 * `voice_gguf_load_metadata(path, "voice_<head>", &meta)` and then
 * validates the fields it cares about against its locked contract.
 *
 * For heads that actually run a forward graph (emotion as of J1.a-forward),
 * `voice_gguf_open` extends the metadata-only path: it mmap's the file,
 * parses the tensor descriptor block, and exposes a flat lookup table
 * the per-head TU walks at session-open time.
 *
 * The metadata struct is intentionally a flat set of the keys the
 * four heads can share. Per-head extensions (e.g. the diarizer's
 * `frames_per_window`) live as additional fields with their own
 * default-zero semantics — a head that doesn't set a key sees zero
 * and uses its own constant.
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
    /* Required audio front-end parameters; the per-head opener refuses
     * to load if these disagree with the values its head expects. Zero
     * if the GGUF didn't set the corresponding key. */
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
    /* Wav2Small-specific shape fields (J1.a-forward). Zero when the
     * GGUF doesn't set them; the per-head opener falls back to its
     * compile-time defaults in that case. */
    int stft_bins;
    int conv1_out;
    int conv2_out;
    int d_model;
    int ffn_dim;
    int num_layers;
    int num_heads;
} voice_gguf_metadata_t;

/* GGUF GGML tensor data types — we only support F32 in the per-head
 * forward graphs today. The conversion scripts emit F32 because the
 * models are tiny and numerical parity matters more than size. */
enum voice_gguf_ggml_type {
    VOICE_GGUF_GGML_TYPE_F32 = 0,
    VOICE_GGUF_GGML_TYPE_F16 = 1,
};

/* Maximum tensor-name length stored inline (sufficient for our naming
 * scheme: `layer<N>.<field>` ~ 20 chars). Names longer than this are
 * truncated and won't be found by `voice_gguf_find_tensor`. */
#define VOICE_GGUF_TENSOR_NAME_MAX 96

/* A single tensor descriptor + pointer into a mmap'd file. */
typedef struct voice_gguf_tensor {
    char     name[VOICE_GGUF_TENSOR_NAME_MAX];
    uint32_t ggml_type;       /* one of voice_gguf_ggml_type */
    int      n_dims;
    int64_t  dims[4];         /* GGUF convention: dims[0] is the
                                 fastest-changing axis. Caller must
                                 reverse for numpy-style indexing. */
    size_t   n_elements;      /* product of dims */
    size_t   offset_in_file;  /* byte offset from start of file */
    size_t   size_in_bytes;
    const void *data;         /* pointer into mmap'd region; valid for
                                 the lifetime of the context */
} voice_gguf_tensor_t;

/* Opaque full-file context: owns the mmap'd region + tensor table. */
typedef struct voice_gguf_context voice_gguf_context_t;

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

/* Open a GGUF file fully — parse the metadata + the tensor descriptor
 * block, mmap the file, and build a tensor lookup table. The caller
 * receives the populated metadata and a heap-allocated context.
 *
 * Same errno-style returns as `voice_gguf_load_metadata` plus
 * -EIO on stat / mmap failure.
 */
int voice_gguf_open(const char *path,
                    const char *prefix,
                    voice_gguf_metadata_t *meta_out,
                    voice_gguf_context_t **ctx_out);

/* Close a context (NULL-safe). Unmaps the file region. */
void voice_gguf_close(voice_gguf_context_t *ctx);

/* Look up a tensor by name. Returns NULL if not found. The returned
 * pointer is owned by the context; do not free. */
const voice_gguf_tensor_t *
voice_gguf_find_tensor(const voice_gguf_context_t *ctx, const char *name);

#ifdef __cplusplus
}
#endif

#endif /* VOICE_CLASSIFIER_VOICE_GGUF_LOADER_H */
