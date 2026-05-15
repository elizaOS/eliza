/*
 * voice-classifier-cpp — minimal GGUF metadata + tensor loader.
 *
 * The four model heads (emotion, speaker, EOT-audio, diarizer) all
 * ship as GGUF files produced by the per-head conversion scripts in
 * `scripts/`. Before running the forward graph (J1.a / J1.b / J1.c)
 * we validate the metadata block matches the locked C-side contract.
 *
 * The K2 wave extends the loader so the WeSpeaker forward graph can
 * actually read its 75 fp32 tensors out of the GGUF without linking
 * the fork's libllama / libggml — the dependency would force the
 * whole voice-classifier-cpp tree to link against the fork tree.
 *
 * GGUF wire format (matches
 * `plugins/plugin-local-inference/native/llama.cpp/ggml/include/gguf.h`):
 *   1.  Magic "GGUF" (4 bytes)
 *   2.  Version (uint32)
 *   3.  Tensor count (int64)
 *   4.  KV count (int64)
 *   5.  For each KV:
 *       - key as length-prefixed string (uint64 len + bytes)
 *       - value type (uint32 from gguf_type enum)
 *       - value (variable per type)
 *   6.  For each tensor:
 *       - name (uint64 len + bytes)
 *       - n_dims (uint32)
 *       - dims (uint64[n_dims])
 *       - type (uint32 from ggml_type enum)
 *       - offset (uint64) — relative to start of tensor-data region
 *   7.  Padding to alignment (default 32)
 *   8.  Tensor data, in the order written by the writer
 *
 * The "general.alignment" KV controls the padding (default 32 if unset).
 *
 * On failure we return one of the documented errno-style negatives.
 */

#include "voice_gguf_loader.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* GGUF wire-format constants. */
#define VC_GGUF_MAGIC "GGUF"
#define VC_GGUF_VERSION_MIN 2
#define VC_GGUF_VERSION_MAX 3
#define VC_GGUF_DEFAULT_ALIGN 32

/* ggml_type values we care about. */
#define VC_GGML_TYPE_F32 0
#define VC_GGML_TYPE_F16 1

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

/* ---------------- low-level I/O ---------------- */

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

/* ---------------- metadata callback ---------------- */

struct vc_gguf_load_state {
    const char *want_prefix;
    voice_gguf_metadata_t *out;
    /* General-level keys also picked up. */
    int alignment;
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

    /* "general.alignment" — uint32 padding for the tensor data block.
     * We pick it up regardless of prefix because tensor decoding needs it. */
    if (strcmp(key, "general.alignment") == 0) {
        if (type != VC_GGUF_TYPE_UINT32) return -1;
        uint32_t v = 0;
        if (vc_gguf_read_u32(f, &v) != 0) return -1;
        s->alignment = (int)v;
        return 1;
    }

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
        .alignment = 0,
    };
    const int rc = vc_gguf_walk(f, (uint64_t)kv_count,
                                 vc_gguf_load_state_cb, &state);
    fclose(f);
    return rc;
}

/* ---------------- tensor enumeration + load (K2) ---------------- */

struct voice_gguf_bundle {
    FILE *f;
    int alignment;
    int64_t tensor_data_base; /* absolute file offset of tensor data */
    int n_tensors;
    voice_gguf_tensor_desc_t *tensors; /* heap-allocated array */
};

static int64_t vc_gguf_align(int64_t off, int align) {
    if (align <= 0) align = VC_GGUF_DEFAULT_ALIGN;
    const int64_t rem = off % align;
    return rem == 0 ? off : off + (align - rem);
}

/* element size in bytes for the supported ggml types. Returns 0 for
 * unsupported. */
static size_t vc_ggml_type_size(int type) {
    switch (type) {
        case VC_GGML_TYPE_F32: return 4;
        case VC_GGML_TYPE_F16: return 2;
        default: return 0;
    }
}

int voice_gguf_open_tensors(const char *path,
                            const char *prefix,
                            voice_gguf_metadata_t *meta_out,
                            voice_gguf_bundle_t **out) {
    if (out) *out = NULL;
    if (!path || !prefix || !meta_out || !out) return -EINVAL;

    memset(meta_out, 0, sizeof(*meta_out));

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
    meta_out->gguf_version = (int)version;

    int64_t tensor_count = 0;
    int64_t kv_count = 0;
    if (vc_gguf_read_i64(f, &tensor_count) != 0 ||
        vc_gguf_read_i64(f, &kv_count) != 0 ||
        tensor_count < 0 || kv_count < 0 || tensor_count > 1000000) {
        fclose(f);
        return -EINVAL;
    }
    meta_out->tensor_count = (int)tensor_count;

    struct vc_gguf_load_state state = {
        .want_prefix = prefix,
        .out = meta_out,
        .alignment = 0,
    };
    const int rc_kv = vc_gguf_walk(f, (uint64_t)kv_count,
                                    vc_gguf_load_state_cb, &state);
    if (rc_kv != 0) {
        fclose(f);
        return rc_kv;
    }

    const int alignment = state.alignment > 0
        ? state.alignment : VC_GGUF_DEFAULT_ALIGN;

    /* Parse the tensor info block. For each tensor we read:
     *   name (str), n_dims (u32), dims (u64[n_dims]),
     *   type (u32), offset (u64).
     */
    voice_gguf_tensor_desc_t *tensors = (voice_gguf_tensor_desc_t *)calloc(
        (size_t)tensor_count, sizeof(*tensors));
    if (!tensors) {
        fclose(f);
        return -ENOMEM;
    }

    for (int64_t i = 0; i < tensor_count; ++i) {
        voice_gguf_tensor_desc_t *t = &tensors[i];
        char *name = NULL;
        int rc = vc_gguf_read_string(f, &name);
        if (rc != 0 || !name) {
            free(tensors);
            fclose(f);
            return rc != 0 ? rc : -EINVAL;
        }
        const size_t nlen = strlen(name);
        if (nlen >= VOICE_GGUF_MAX_TENSOR_NAME) {
            free(name);
            free(tensors);
            fclose(f);
            return -EINVAL;
        }
        memcpy(t->name, name, nlen);
        t->name[nlen] = '\0';
        free(name);

        uint32_t n_dims = 0;
        if (vc_gguf_read_u32(f, &n_dims) != 0 || n_dims == 0 || n_dims > 4) {
            free(tensors);
            fclose(f);
            return -EINVAL;
        }
        t->ndim = (int)n_dims;
        t->n_elements = 1;
        for (int d = 0; d < (int)n_dims; ++d) {
            uint64_t dim = 0;
            if (vc_gguf_read_u64(f, &dim) != 0 ||
                dim == 0 || dim > (1ULL << 40)) {
                free(tensors);
                fclose(f);
                return -EINVAL;
            }
            t->dims[d] = (int64_t)dim;
            t->n_elements *= (int64_t)dim;
        }
        for (int d = (int)n_dims; d < 4; ++d) t->dims[d] = 1;

        uint32_t tt = 0;
        if (vc_gguf_read_u32(f, &tt) != 0) {
            free(tensors);
            fclose(f);
            return -EINVAL;
        }
        t->ggml_type = (int)tt;

        uint64_t off = 0;
        if (vc_gguf_read_u64(f, &off) != 0) {
            free(tensors);
            fclose(f);
            return -EINVAL;
        }
        /* Provisional offset relative to tensor_data_base. */
        t->data_offset = (int64_t)off;

        const size_t elsz = vc_ggml_type_size(t->ggml_type);
        t->n_bytes = elsz > 0 ? (int64_t)(elsz * (size_t)t->n_elements) : 0;
    }

    /* The tensor data region starts at the next aligned position after
     * the tensor info block. */
    const long pos = ftell(f);
    if (pos < 0) {
        free(tensors);
        fclose(f);
        return -EINVAL;
    }
    const int64_t base = vc_gguf_align((int64_t)pos, alignment);
    for (int64_t i = 0; i < tensor_count; ++i) {
        tensors[i].data_offset += base;
    }

    voice_gguf_bundle_t *b = (voice_gguf_bundle_t *)calloc(1, sizeof(*b));
    if (!b) {
        free(tensors);
        fclose(f);
        return -ENOMEM;
    }
    b->f = f;
    b->alignment = alignment;
    b->tensor_data_base = base;
    b->n_tensors = (int)tensor_count;
    b->tensors = tensors;
    *out = b;
    return 0;
}

int voice_gguf_tensor_count(const voice_gguf_bundle_t *b) {
    return b ? b->n_tensors : 0;
}

const voice_gguf_tensor_desc_t *voice_gguf_tensor_at(
    const voice_gguf_bundle_t *b, int idx) {
    if (!b || idx < 0 || idx >= b->n_tensors) return NULL;
    return &b->tensors[idx];
}

const voice_gguf_tensor_desc_t *voice_gguf_tensor_find(
    const voice_gguf_bundle_t *b, const char *name) {
    if (!b || !name) return NULL;
    for (int i = 0; i < b->n_tensors; ++i) {
        if (strcmp(b->tensors[i].name, name) == 0) return &b->tensors[i];
    }
    return NULL;
}

int voice_gguf_read_tensor_f32(const voice_gguf_bundle_t *b,
                               const char *name,
                               float *dst,
                               size_t dst_capacity) {
    if (!b || !name || !dst) return -EINVAL;
    const voice_gguf_tensor_desc_t *t = voice_gguf_tensor_find(b, name);
    if (!t) return -EINVAL;
    if (t->ggml_type != VC_GGML_TYPE_F32) return -EINVAL;
    if ((size_t)t->n_elements > dst_capacity) return -ENOSPC;
    if (fseek(b->f, (long)t->data_offset, SEEK_SET) != 0) return -EIO;
    if (fread(dst, sizeof(float), (size_t)t->n_elements, b->f)
        != (size_t)t->n_elements) return -EIO;
    return 0;
}

void voice_gguf_close_tensors(voice_gguf_bundle_t *b) {
    if (!b) return;
    if (b->f) fclose(b->f);
    if (b->tensors) free(b->tensors);
    free(b);
}
