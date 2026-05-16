/*
 * voice-classifier-cpp — GGUF tensor loader.
 *
 * Companion to voice_gguf_loader.{c,h} (metadata only). This module
 * walks the tensor descriptor block and gives the per-head forward
 * passes (voice_diarizer.c first) a name-keyed map of fp32 tensors
 * mmapped from the GGUF file.
 *
 * The forward passes hardcode tensor names against the conversion
 * script's contract (see scripts/voice_diarizer_to_gguf.py). Any
 * mismatch is a refusal-to-load at session open: the C side does not
 * fabricate weights.
 *
 * We only support fp32 tensors today. Quantized variants (q8_0, q4_0)
 * are a follow-up — when they land, dequant happens inside the loader
 * so the forward pass stays in fp32 math.
 */

#ifndef VOICE_CLASSIFIER_VOICE_GGUF_TENSORS_H
#define VOICE_CLASSIFIER_VOICE_GGUF_TENSORS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VC_GGUF_MAX_TENSOR_NAME 128
#define VC_GGUF_MAX_TENSOR_DIMS 4

typedef struct voice_gguf_weight_tensor {
    char name[VC_GGUF_MAX_TENSOR_NAME];
    /* Framework dims (un-reversed, so e.g. [80, 1, 251] for a Conv1d
     * weight). The on-disk gguf shape array stores these reversed; the
     * loader un-reverses on read. */
    uint32_t ndim;
    uint64_t dims[VC_GGUF_MAX_TENSOR_DIMS];
    /* Total element count (product of dims). */
    uint64_t n_elements;
    /* Pointer into the mmapped region — fp32 row-major. NULL until the
     * tensor block is mmapped. Lifetime tied to voice_gguf_tensors. */
    const float *data;
} voice_gguf_weight_tensor_t;

typedef struct voice_gguf_tensors {
    /* The mmapped region. */
    void *map;
    size_t map_size;
    /* All tensor descriptors. */
    voice_gguf_weight_tensor_t *tensors;
    size_t n_tensors;
} voice_gguf_tensors_t;

/* Open a GGUF file and parse out every tensor descriptor + map the
 * data block so callers can read fp32 weights by name. Returns 0 on
 * success; on failure `*out` is zeroed.
 *
 * Errors:
 *   -ENOENT : file doesn't exist
 *   -EINVAL : bad magic, wrong version, unsupported quant type
 *   -ENOMEM : alloc failure
 */
int voice_gguf_tensors_open(const char *path, voice_gguf_tensors_t *out);

/* Look up a tensor by name. Returns NULL if not present. */
const voice_gguf_weight_tensor_t *voice_gguf_tensors_find(
    const voice_gguf_tensors_t *t,
    const char *name);

/* Release the mmap + descriptor array. NULL-safe. */
void voice_gguf_tensors_close(voice_gguf_tensors_t *t);

#ifdef __cplusplus
}
#endif

#endif /* VOICE_CLASSIFIER_VOICE_GGUF_TENSORS_H */
