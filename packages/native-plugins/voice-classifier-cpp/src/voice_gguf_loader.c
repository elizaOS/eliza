/*
 * voice-classifier-cpp — minimal GGUF metadata loader.
 *
 * The four model heads (emotion, speaker, EOT-audio, diarizer) all
 * ship as GGUF files produced by the per-head conversion scripts in
 * `scripts/`. Before running the forward graph (the J1.a / J1.b /
 * J1.c work) we need to validate the metadata block matches the
 * locked C-side contract: sample rate, mel parameters, output dim,
 * class order (where applicable), upstream commit. This file is the
 * shared metadata reader.
 *
 * We deliberately do NOT depend on the fork's libllama / libggml in
 * this TU — the dependency would force voice-classifier-cpp to link
 * the entire fork tree just to read a few KV pairs, and the GGUF
 * binary format is small and stable (version 3 has been frozen for
 * ~18 months). We parse the file header + KV block directly. Tensor
 * data is left untouched here; the per-head forward graphs (J1.a /
 * J1.b / J1.c) will read tensors via mmap when they land.
 *
 * The GGUF wire format (see `plugins/plugin-local-inference/native/llama.cpp/ggml/include/gguf.h`):
 *
 *   1.  Magic "GGUF" (4 bytes)
 *   2.  Version (uint32)
 *   3.  Tensor count (int64)
 *   4.  KV count (int64)
 *   5.  For each KV:
 *       - key as length-prefixed string (uint64 len + bytes)
 *       - value type (uint32 from gguf_type enum)
 *       - value (variable per type)
 *   6.  Tensor descriptors (one per tensor count) — name, ndim, dims,
 *       type, data offset.
 *
 * We only need step 1-5; step 6+ is for the forward-pass code.
 *
 * On failure we return one of the documented errno-style negatives
 * and the caller writes through to the model open's return code:
 *
 *   -ENOENT : file doesn't exist / can't open
 *   -EINVAL : bad magic, wrong version, malformed KV, key not found,
 *             metadata mismatch (sample rate, class count, etc)
 *   -ENOMEM : allocation failure during string parsing
 */

#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* GGUF wire-format constants — must match
 * plugins/plugin-local-inference/native/llama.cpp/ggml/include/gguf.h. */
#define VC_GGUF_MAGIC "GGUF"
#define VC_GGUF_VERSION_MIN 2
#define VC_GGUF_VERSION_MAX 3

enum vc_gguf_type {
    VC_GGUF_TYPE_UINT8   = 0,
    VC_GGUF_TYPE_INT8    = 1,
    VC_GGUF_TYPE_UINT16  = 2,
    VC_GGUF_TYPE_INT16   = 3,
    VC_GGUF_TYPE_UINT32  = 4,
    VC_GGUF_TYPE_INT32   = 5,
    VC_GGUF_TYPE_FLOAT32 = 6,
    VC_GGUF_TYPE_BOOL    = 7,
    VC_GGUF_TYPE_STRING  = 8,
    VC_GGUF_TYPE_ARRAY   = 9,
    VC_GGUF_TYPE_UINT64  = 10,
    VC_GGUF_TYPE_INT64   = 11,
    VC_GGUF_TYPE_FLOAT64 = 12,
};

/* Read `n` bytes from `f` into `buf`. Returns 0 on success, -1 on EOF
 * or read error. */
static int vc_gguf_read(FILE *f, void *buf, size_t n) {
    return fread(buf, 1, n, f) == n ? 0 : -1;
}

/* Skip `n` bytes in `f`. */
static int vc_gguf_skip(FILE *f, size_t n) {
    return fseek(f, (long)n, SEEK_CUR) == 0 ? 0 : -1;
}

/* Read a uint32 (LE) from `f`. */
static int vc_gguf_read_u32(FILE *f, uint32_t *out) {
    return vc_gguf_read(f, out, sizeof(*out));
}

/* Read a uint64 (LE) from `f`. */
static int vc_gguf_read_u64(FILE *f, uint64_t *out) {
    return vc_gguf_read(f, out, sizeof(*out));
}

/* Read an int64 (LE) from `f`. */
static int vc_gguf_read_i64(FILE *f, int64_t *out) {
    return vc_gguf_read(f, out, sizeof(*out));
}

/* Read a GGUF-style length-prefixed string into a heap buffer.
 * Returns 0 on success and sets `*out` to a NUL-terminated string the
 * caller must `free()`. Returns -ENOMEM on alloc failure, -EINVAL on
 * malformed string. */
static int vc_gguf_read_string(FILE *f, char **out) {
    *out = NULL;
    uint64_t len = 0;
    if (vc_gguf_read_u64(f, &len) != 0) return -EINVAL;
    if (len > (1U << 20)) return -EINVAL; /* refuse > 1 MB strings */
    char *buf = (char *)malloc(len + 1);
    if (!buf) return -ENOMEM;
    if (len > 0 && vc_gguf_read(f, buf, (size_t)len) != 0) {
        free(buf);
        return -EINVAL;
    }
    buf[len] = '\0';
    *out = buf;
    return 0;
}

/* Skip a single GGUF value of `type` whose key has just been read.
 * Used when we hit a key we don't care about. Returns 0 on success,
 * -EINVAL on malformed value. */
static int vc_gguf_skip_value(FILE *f, uint32_t type) {
    switch ((enum vc_gguf_type)type) {
        case VC_GGUF_TYPE_UINT8:
        case VC_GGUF_TYPE_INT8:
        case VC_GGUF_TYPE_BOOL:
            return vc_gguf_skip(f, 1);
        case VC_GGUF_TYPE_UINT16:
        case VC_GGUF_TYPE_INT16:
            return vc_gguf_skip(f, 2);
        case VC_GGUF_TYPE_UINT32:
        case VC_GGUF_TYPE_INT32:
        case VC_GGUF_TYPE_FLOAT32:
            return vc_gguf_skip(f, 4);
        case VC_GGUF_TYPE_UINT64:
        case VC_GGUF_TYPE_INT64:
        case VC_GGUF_TYPE_FLOAT64:
            return vc_gguf_skip(f, 8);
        case VC_GGUF_TYPE_STRING: {
            uint64_t len = 0;
            if (vc_gguf_read_u64(f, &len) != 0) return -EINVAL;
            if (len > (1U << 24)) return -EINVAL;
            return vc_gguf_skip(f, (size_t)len);
        }
        case VC_GGUF_TYPE_ARRAY: {
            uint32_t inner_type = 0;
            uint64_t count = 0;
            if (vc_gguf_read_u32(f, &inner_type) != 0) return -EINVAL;
            if (vc_gguf_read_u64(f, &count) != 0) return -EINVAL;
            for (uint64_t i = 0; i < count; ++i) {
                if (vc_gguf_skip_value(f, inner_type) != 0) return -EINVAL;
            }
            return 0;
        }
        default:
            return -EINVAL;
    }
}

/* Walk every KV pair, invoking `cb(key, type, file_pos, user)` for
 * each. The callback returns 0 to "skip this value" (we advance past
 * it ourselves), or -1 to "claim this value" (in which case the
 * callback is responsible for reading the bytes of the value before
 * returning, leaving the file pointer just past the value).
 *
 * Returns 0 when the whole KV block is consumed, negative on error. */
typedef int (*vc_gguf_kv_cb)(const char *key,
                              uint32_t type,
                              FILE *f,
                              void *user);

static int vc_gguf_walk(FILE *f,
                        uint64_t kv_count,
                        vc_gguf_kv_cb cb,
                        void *user) {
    for (uint64_t i = 0; i < kv_count; ++i) {
        char *key = NULL;
        int rc = vc_gguf_read_string(f, &key);
        if (rc != 0) return rc;
        uint32_t type = 0;
        if (vc_gguf_read_u32(f, &type) != 0) {
            free(key);
            return -EINVAL;
        }
        const int claimed = cb(key, type, f, user);
        free(key);
        if (claimed == 0) {
            /* callback skipped — advance past the value ourselves */
            const int sk = vc_gguf_skip_value(f, type);
            if (sk != 0) return sk;
        } else if (claimed < 0) {
            /* callback reported an error */
            return -EINVAL;
        }
        /* claimed > 0: callback consumed the value and advanced f */
    }
    return 0;
}

/* Callback state for `voice_gguf_load_metadata`. */
struct vc_gguf_load_state {
    const char *want_prefix;   /* "voice_emotion" / "voice_speaker" / ... */
    voice_gguf_metadata_t *out;
    int have_sample_rate;
    int have_num_classes;
    int have_n_mels;
    int have_n_fft;
    int have_hop;
    int have_variant;
};

/* Compare `key` against `prefix + "." + suffix`. Returns 1 on match. */
static int vc_gguf_key_eq(const char *key,
                          const char *prefix,
                          const char *suffix) {
    const size_t plen = strlen(prefix);
    const size_t slen = strlen(suffix);
    if (strlen(key) != plen + 1 + slen) return 0;
    if (memcmp(key, prefix, plen) != 0) return 0;
    if (key[plen] != '.') return 0;
    if (memcmp(key + plen + 1, suffix, slen) != 0) return 0;
    return 1;
}

static int vc_gguf_load_state_cb(const char *key,
                                  uint32_t type,
                                  FILE *f,
                                  void *user) {
    struct vc_gguf_load_state *s = (struct vc_gguf_load_state *)user;

    /* Recognized keys: <prefix>.{sample_rate, num_classes, n_mels,
     * n_fft, hop, variant}. All numeric keys are uint32 except for
     * variant (string). */
    if (vc_gguf_key_eq(key, s->want_prefix, "sample_rate")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->sample_rate = (int)v;
        s->have_sample_rate = 1;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "num_classes")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->num_classes = (int)v;
        s->have_num_classes = 1;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "embedding_dim")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->embedding_dim = (int)v;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "n_mels")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->n_mels = (int)v;
        s->have_n_mels = 1;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "n_fft")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->n_fft = (int)v;
        s->have_n_fft = 1;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "hop")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->hop = (int)v;
        s->have_hop = 1;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "variant")) {
        if (type != VC_GGUF_TYPE_STRING) return -1;
        char *str = NULL;
        const int rc = vc_gguf_read_string(f, &str);
        if (rc != 0) return -1;
        const size_t n = sizeof(s->out->variant) - 1;
        strncpy(s->out->variant, str, n);
        s->out->variant[n] = '\0';
        free(str);
        s->have_variant = 1;
        return 1;
    }
    /* Unknown key — let the walker skip it. */
    return 0;
}

int voice_gguf_load_metadata(const char *path,
                             const char *prefix,
                             voice_gguf_metadata_t *out) {
    if (!path || !prefix || !out) return -EINVAL;
    memset(out, 0, sizeof(*out));

    FILE *f = fopen(path, "rb");
    if (!f) return -ENOENT;

    /* magic + version */
    char magic[4] = {0};
    if (vc_gguf_read(f, magic, 4) != 0 ||
        memcmp(magic, VC_GGUF_MAGIC, 4) != 0) {
        fclose(f);
        return -EINVAL;
    }
    uint32_t version = 0;
    if (vc_gguf_read_u32(f, &version) != 0 ||
        version < VC_GGUF_VERSION_MIN ||
        version > VC_GGUF_VERSION_MAX) {
        fclose(f);
        return -EINVAL;
    }
    out->gguf_version = (int)version;

    /* tensor count, kv count */
    int64_t tensor_count = 0;
    int64_t kv_count = 0;
    if (vc_gguf_read_i64(f, &tensor_count) != 0 ||
        vc_gguf_read_i64(f, &kv_count) != 0 ||
        tensor_count < 0 || kv_count < 0) {
        fclose(f);
        return -EINVAL;
    }
    out->tensor_count = (int)tensor_count;

    /* walk KV block */
    struct vc_gguf_load_state state = {
        .want_prefix = prefix,
        .out = out,
    };
    const int rc = vc_gguf_walk(f, (uint64_t)kv_count,
                                 vc_gguf_load_state_cb, &state);
    fclose(f);
    if (rc != 0) return rc;

    /* Every head requires at least one of these keys; the per-head
     * caller (voice_emotion_open etc) validates the specific subset
     * relevant to its head. We do NOT enforce here so a head can opt
     * out (e.g. the diarizer doesn't use num_classes the same way). */
    return 0;
}
