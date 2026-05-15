/*
 * voice-classifier-cpp — internal GGUF metadata loader.
 *
 * Not exported in the public C ABI; consumed only by the per-head TUs
 * inside this library. Each head's `*_open` calls
 * `voice_gguf_load_metadata(path, "voice_<head>", &meta)` and then
 * validates the fields it cares about against its locked contract.
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

#ifdef __cplusplus
}
#endif

#endif /* VOICE_CLASSIFIER_VOICE_GGUF_LOADER_H */
