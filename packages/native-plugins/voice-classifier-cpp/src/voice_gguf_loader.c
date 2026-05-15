/*
 * voice-classifier-cpp — minimal GGUF metadata loader.
 *
 * The four model heads (emotion, speaker, EOT-audio, diarizer) all
 * ship as GGUF files produced by the per-head conversion scripts in
 * `scripts/`. Before running the forward graph we validate the
 * metadata block matches the locked C-side contract.
 *
 * We deliberately do NOT depend on the fork's libllama / libggml in
 * this TU — the dependency would force voice-classifier-cpp to link
 * the entire fork tree just to read a few KV pairs.
 *
 * For weight-tensor reads, see voice_gguf_tensors.{c,h}.
 *
 * On failure we return one of the documented errno-style negatives:
 *   -ENOENT : file doesn't exist / can't open
 *   -EINVAL : bad magic, wrong version, malformed KV
 *   -ENOMEM : allocation failure during string parsing
 */

#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

static int vc_gguf_read(FILE *f, void *buf, size_t n) {
    return fread(buf, 1, n, f) == n ? 0 : -1;
}

static int vc_gguf_skip(FILE *f, size_t n) {
    return fseek(f, (long)n, SEEK_CUR) == 0 ? 0 : -1;
}

static int vc_gguf_read_u32(FILE *f, uint32_t *out) {
    return vc_gguf_read(f, out, sizeof(*out));
}

static int vc_gguf_read_u64(FILE *f, uint64_t *out) {
    return vc_gguf_read(f, out, sizeof(*out));
}

static int vc_gguf_read_i64(FILE *f, int64_t *out) {
    return vc_gguf_read(f, out, sizeof(*out));
}

static int vc_gguf_read_string(FILE *f, char **out) {
    *out = NULL;
    uint64_t len = 0;
    if (vc_gguf_read_u64(f, &len) != 0) return -EINVAL;
    if (len > (1U << 20)) return -EINVAL;
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
            const int sk = vc_gguf_skip_value(f, type);
            if (sk != 0) return sk;
        } else if (claimed < 0) {
            return -EINVAL;
        }
    }
    return 0;
}

struct vc_gguf_load_state {
    const char *want_prefix;
    voice_gguf_metadata_t *out;
};

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

    if (vc_gguf_key_eq(key, s->want_prefix, "sample_rate")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->sample_rate = (int)v;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "num_classes")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->num_classes = (int)v;
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
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "n_fft")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->n_fft = (int)v;
        return 1;
    }
    if (vc_gguf_key_eq(key, s->want_prefix, "hop")) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->out->hop = (int)v;
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
        return 1;
    }
    /* Wav2Small-specific uint32 keys: read into the matching field
     * and let the per-head opener validate against its expectation. */
    struct {
        const char *suffix;
        int *target;
    } u32_extras[] = {
        { "stft_bins",  &s->out->stft_bins  },
        { "conv1_out",  &s->out->conv1_out  },
        { "conv2_out",  &s->out->conv2_out  },
        { "d_model",    &s->out->d_model    },
        { "ffn_dim",    &s->out->ffn_dim    },
        { "num_layers", &s->out->num_layers },
        { "num_heads",  &s->out->num_heads  },
    };
    for (size_t i = 0; i < sizeof(u32_extras) / sizeof(u32_extras[0]); ++i) {
        if (vc_gguf_key_eq(key, s->want_prefix, u32_extras[i].suffix)) {
            if (type != VC_GGUF_TYPE_UINT32) return -1;
            uint32_t v = 0;
            if (vc_gguf_read_u32(f, &v) != 0) return -1;
            *u32_extras[i].target = (int)v;
            return 1;
        }
    }
    return 0;
}

int voice_gguf_load_metadata(const char *path,
                             const char *prefix,
                             voice_gguf_metadata_t *out) {
    if (!path || !prefix || !out) return -EINVAL;
    memset(out, 0, sizeof(*out));

    FILE *f = fopen(path, "rb");
    if (!f) return -ENOENT;

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

    int64_t tensor_count = 0;
    int64_t kv_count = 0;
    if (vc_gguf_read_i64(f, &tensor_count) != 0 ||
        vc_gguf_read_i64(f, &kv_count) != 0 ||
        tensor_count < 0 || kv_count < 0) {
        fclose(f);
        return -EINVAL;
    }
    out->tensor_count = (int)tensor_count;

    struct vc_gguf_load_state state = {
        .want_prefix = prefix,
        .out = out,
    };
    const int rc = vc_gguf_walk(f, (uint64_t)kv_count,
                                 vc_gguf_load_state_cb, &state);
    fclose(f);
    if (rc != 0) return rc;

    return 0;
}
