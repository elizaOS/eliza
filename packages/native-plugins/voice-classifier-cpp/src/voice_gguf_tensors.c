/*
 * voice-classifier-cpp — GGUF tensor loader implementation.
 *
 * Walks the tensor descriptor block of a GGUF file and mmaps the data
 * block. Supports fp32 tensors only (the J1.c-forward diarizer ships
 * with fp32 weights; quant variants land in a follow-up).
 *
 * Wire format (gguf v3, see plugins/plugin-local-inference/native/llama.cpp/ggml/include/gguf.h):
 *
 *   header:
 *     uint32 magic ("GGUF")
 *     uint32 version (= 3)
 *     int64  tensor_count
 *     int64  kv_count
 *   kv block (skip)
 *   tensor descriptors (one per tensor):
 *     str    name (uint64 len + bytes)
 *     uint32 n_dims
 *     int64[n_dims] dims (in REVERSED framework order)
 *     uint32 type (= 0 for fp32)
 *     uint64 offset (from start of data block)
 *   alignment padding (default 32-byte alignment)
 *   tensor data block (contiguous, each tensor at file_offset + data_start + tensor.offset)
 */

#include "voice_gguf_tensors.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define VC_GGUF_MAGIC "GGUF"
#define VC_GGUF_VERSION_MIN 2
#define VC_GGUF_VERSION_MAX 3
#define VC_GGUF_DEFAULT_ALIGNMENT 32

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

/* GGML quant types (subset we care about for this loader). */
#define VC_GGML_TYPE_F32 0

static int vc_read_u32(const uint8_t *p, size_t map_size, size_t *cur, uint32_t *out) {
    if (*cur + 4 > map_size) return -1;
    memcpy(out, p + *cur, 4);
    *cur += 4;
    return 0;
}

static int vc_read_u64(const uint8_t *p, size_t map_size, size_t *cur, uint64_t *out) {
    if (*cur + 8 > map_size) return -1;
    memcpy(out, p + *cur, 8);
    *cur += 8;
    return 0;
}

static int vc_read_i64(const uint8_t *p, size_t map_size, size_t *cur, int64_t *out) {
    return vc_read_u64(p, map_size, cur, (uint64_t *)out);
}

/* Skip a length-prefixed string. */
static int vc_skip_str(const uint8_t *p, size_t map_size, size_t *cur) {
    uint64_t len = 0;
    if (vc_read_u64(p, map_size, cur, &len) != 0) return -1;
    if (*cur + len > map_size) return -1;
    *cur += len;
    return 0;
}

/* Read a length-prefixed string into a fixed buffer. Returns the length
 * of the source string (which may be > buf_size-1; we truncate). */
static int vc_read_str(const uint8_t *p, size_t map_size, size_t *cur,
                       char *buf, size_t buf_size) {
    uint64_t len = 0;
    if (vc_read_u64(p, map_size, cur, &len) != 0) return -1;
    if (*cur + len > map_size) return -1;
    size_t to_copy = (len < buf_size - 1) ? len : (buf_size - 1);
    memcpy(buf, p + *cur, to_copy);
    buf[to_copy] = '\0';
    *cur += len;
    return 0;
}

/* Skip a kv value of given type. */
static int vc_skip_kv_value(const uint8_t *p, size_t map_size, size_t *cur, uint32_t type);

static int vc_skip_kv_value(const uint8_t *p, size_t map_size, size_t *cur, uint32_t type) {
    switch (type) {
        case VC_GGUF_TYPE_UINT8: case VC_GGUF_TYPE_INT8: case VC_GGUF_TYPE_BOOL:
            if (*cur + 1 > map_size) return -1;
            *cur += 1;
            return 0;
        case VC_GGUF_TYPE_UINT16: case VC_GGUF_TYPE_INT16:
            if (*cur + 2 > map_size) return -1;
            *cur += 2;
            return 0;
        case VC_GGUF_TYPE_UINT32: case VC_GGUF_TYPE_INT32: case VC_GGUF_TYPE_FLOAT32:
            if (*cur + 4 > map_size) return -1;
            *cur += 4;
            return 0;
        case VC_GGUF_TYPE_UINT64: case VC_GGUF_TYPE_INT64: case VC_GGUF_TYPE_FLOAT64:
            if (*cur + 8 > map_size) return -1;
            *cur += 8;
            return 0;
        case VC_GGUF_TYPE_STRING:
            return vc_skip_str(p, map_size, cur);
        case VC_GGUF_TYPE_ARRAY: {
            uint32_t inner = 0;
            uint64_t count = 0;
            if (vc_read_u32(p, map_size, cur, &inner) != 0) return -1;
            if (vc_read_u64(p, map_size, cur, &count) != 0) return -1;
            for (uint64_t i = 0; i < count; ++i) {
                if (vc_skip_kv_value(p, map_size, cur, inner) != 0) return -1;
            }
            return 0;
        }
        default:
            return -1;
    }
}

int voice_gguf_tensors_open(const char *path, voice_gguf_tensors_t *out) {
    if (!path || !out) return -EINVAL;
    memset(out, 0, sizeof(*out));

    int fd = open(path, O_RDONLY);
    if (fd < 0) return -ENOENT;
    struct stat st;
    if (fstat(fd, &st) < 0) {
        close(fd);
        return -ENOENT;
    }
    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (map == MAP_FAILED) return -ENOMEM;
    const uint8_t *p = (const uint8_t *)map;
    const size_t map_size = (size_t)st.st_size;

    size_t cur = 0;
    /* Magic + version */
    if (map_size < 12 || memcmp(p, VC_GGUF_MAGIC, 4) != 0) {
        munmap(map, map_size); return -EINVAL;
    }
    cur = 4;
    uint32_t version = 0;
    if (vc_read_u32(p, map_size, &cur, &version) != 0 ||
        version < VC_GGUF_VERSION_MIN || version > VC_GGUF_VERSION_MAX) {
        munmap(map, map_size); return -EINVAL;
    }

    int64_t n_tensors = 0, n_kvs = 0;
    if (vc_read_i64(p, map_size, &cur, &n_tensors) != 0 ||
        vc_read_i64(p, map_size, &cur, &n_kvs) != 0 ||
        n_tensors < 0 || n_kvs < 0) {
        munmap(map, map_size); return -EINVAL;
    }

    /* Skip KV block (we have a separate metadata loader for those). */
    uint64_t alignment = VC_GGUF_DEFAULT_ALIGNMENT;
    for (int64_t i = 0; i < n_kvs; ++i) {
        /* Read the key — we need to peek for "general.alignment". */
        char key[256];
        if (vc_read_str(p, map_size, &cur, key, sizeof(key)) != 0) {
            munmap(map, map_size); return -EINVAL;
        }
        uint32_t kv_type = 0;
        if (vc_read_u32(p, map_size, &cur, &kv_type) != 0) {
            munmap(map, map_size); return -EINVAL;
        }
        if (strcmp(key, "general.alignment") == 0 && kv_type == VC_GGUF_TYPE_UINT32) {
            uint32_t v = 0;
            if (vc_read_u32(p, map_size, &cur, &v) != 0) {
                munmap(map, map_size); return -EINVAL;
            }
            alignment = v ? (uint64_t)v : VC_GGUF_DEFAULT_ALIGNMENT;
        } else {
            if (vc_skip_kv_value(p, map_size, &cur, kv_type) != 0) {
                munmap(map, map_size); return -EINVAL;
            }
        }
    }

    /* Tensor descriptors. */
    voice_gguf_weight_tensor_t *tensors =
        (voice_gguf_weight_tensor_t *)calloc((size_t)n_tensors, sizeof(*tensors));
    if (!tensors) {
        munmap(map, map_size);
        return -ENOMEM;
    }

    uint64_t max_offset_end = 0;

    for (int64_t i = 0; i < n_tensors; ++i) {
        if (vc_read_str(p, map_size, &cur, tensors[i].name, sizeof(tensors[i].name)) != 0) {
            free(tensors); munmap(map, map_size); return -EINVAL;
        }
        uint32_t ndim = 0;
        if (vc_read_u32(p, map_size, &cur, &ndim) != 0 || ndim > VC_GGUF_MAX_TENSOR_DIMS) {
            free(tensors); munmap(map, map_size); return -EINVAL;
        }
        tensors[i].ndim = ndim;
        /* dims are stored in REVERSED framework order. We un-reverse
         * here so callers see e.g. [80, 1, 251] for a conv weight. */
        int64_t rev_dims[VC_GGUF_MAX_TENSOR_DIMS] = {0};
        for (uint32_t d = 0; d < ndim; ++d) {
            if (vc_read_i64(p, map_size, &cur, &rev_dims[d]) != 0 || rev_dims[d] < 0) {
                free(tensors); munmap(map, map_size); return -EINVAL;
            }
        }
        uint64_t nelem = 1;
        for (uint32_t d = 0; d < ndim; ++d) {
            tensors[i].dims[d] = (uint64_t)rev_dims[ndim - 1 - d];
            nelem *= tensors[i].dims[d];
        }
        tensors[i].n_elements = nelem;

        uint32_t ttype = 0;
        if (vc_read_u32(p, map_size, &cur, &ttype) != 0) {
            free(tensors); munmap(map, map_size); return -EINVAL;
        }
        if (ttype != VC_GGML_TYPE_F32) {
            /* Refuse quantized tensors for now — the J1.c-forward diarizer
             * ships fp32. Quant variants will land in a follow-up. */
            free(tensors); munmap(map, map_size); return -EINVAL;
        }
        uint64_t off = 0;
        if (vc_read_u64(p, map_size, &cur, &off) != 0) {
            free(tensors); munmap(map, map_size); return -EINVAL;
        }
        /* Stash the offset temporarily in n_elements bits — we'll fix
         * up `data` below once we know data_start. */
        /* Use a parallel array. */
        tensors[i].data = (const float *)(uintptr_t)off;  /* tentative */
        const uint64_t end = off + nelem * sizeof(float);
        if (end > max_offset_end) max_offset_end = end;
    }

    /* Data block starts at the next aligned offset. */
    const uint64_t data_start = (cur + alignment - 1) & ~(alignment - 1);
    if (data_start + max_offset_end > map_size) {
        free(tensors); munmap(map, map_size); return -EINVAL;
    }

    /* Patch up data pointers. */
    for (int64_t i = 0; i < n_tensors; ++i) {
        const uint64_t off = (uint64_t)(uintptr_t)tensors[i].data;
        tensors[i].data = (const float *)(p + data_start + off);
    }

    out->map = map;
    out->map_size = map_size;
    out->tensors = tensors;
    out->n_tensors = (size_t)n_tensors;
    return 0;
}

const voice_gguf_weight_tensor_t *voice_gguf_tensors_find(
    const voice_gguf_tensors_t *t, const char *name) {
    if (!t || !name) return NULL;
    for (size_t i = 0; i < t->n_tensors; ++i) {
        if (strcmp(t->tensors[i].name, name) == 0) {
            return &t->tensors[i];
        }
    }
    return NULL;
}

void voice_gguf_tensors_close(voice_gguf_tensors_t *t) {
    if (!t) return;
    if (t->tensors) {
        free(t->tensors);
        t->tensors = NULL;
    }
    if (t->map) {
        munmap(t->map, t->map_size);
        t->map = NULL;
    }
    t->map_size = 0;
    t->n_tensors = 0;
}
