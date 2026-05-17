/*
 * Minimal GGUF v3 reader for doctr-cpp Phase 2.
 *
 * The doctr GGUF is produced by scripts/doctr_to_gguf.py with
 * arch="doctr" and contains only fp32 tensors plus a handful of
 * string/uint32 metadata keys. The full GGUF spec carries dozens of
 * tensor dtypes and quantization blocks; we deliberately only parse
 * what we emit. Unknown dtypes are a hard error — silent acceptance
 * would let a quantized future GGUF load and produce garbage output.
 *
 * Layout (GGUF v3, little-endian):
 *   header:
 *     magic[4]              = "GGUF"
 *     version (u32)         = 3
 *     tensor_count (u64)
 *     kv_count (u64)
 *   for kv_count:
 *     key string
 *     value type (u32)
 *     value (encoded per type)
 *   for tensor_count:
 *     name string
 *     n_dims (u32)
 *     dims[n_dims] (u64)
 *     dtype (u32)
 *     offset (u64, relative to start of tensor data section)
 *   tensor data section, aligned to general.alignment (default 32).
 *
 * Strings are u64-length-prefixed, NOT NUL-terminated. Arrays are u32
 * elem-type + u64 length + elements.
 */

#include "doctr_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* ── GGUF constants we use ────────────────────────────────────────────── */

#define GGUF_MAGIC  "GGUF"

enum {
    GGUF_TYPE_UINT8   = 0,
    GGUF_TYPE_INT8    = 1,
    GGUF_TYPE_UINT16  = 2,
    GGUF_TYPE_INT16   = 3,
    GGUF_TYPE_UINT32  = 4,
    GGUF_TYPE_INT32   = 5,
    GGUF_TYPE_FLOAT32 = 6,
    GGUF_TYPE_BOOL    = 7,
    GGUF_TYPE_STRING  = 8,
    GGUF_TYPE_ARRAY   = 9,
    GGUF_TYPE_UINT64  = 10,
    GGUF_TYPE_INT64   = 11,
    GGUF_TYPE_FLOAT64 = 12,
};

enum {
    GGML_TYPE_F32 = 0,
    GGML_TYPE_F16 = 1,
};

#define MAX_TENSOR_DIMS 4

typedef struct {
    char    *name;
    uint32_t type;       /* GGUF_TYPE_* */
    uint32_t arr_type;   /* when type==ARRAY */
    /* For scalars: one of these holds the value. For strings: str_val
     * points into the mmap (not NUL-terminated; len is str_len). For
     * arrays: arr_data points into the mmap. */
    union {
        uint8_t  u8;
        int8_t   i8;
        uint16_t u16;
        int16_t  i16;
        uint32_t u32;
        int32_t  i32;
        float    f32;
        uint64_t u64;
        int64_t  i64;
        double   f64;
        int      b;
    } scalar;
    const char *str_val;
    uint64_t    str_len;
    const void *arr_data;
    uint64_t    arr_len;
} doctr_gguf_kv;

typedef struct {
    char       *name;
    int         ndim;
    int64_t     dims[MAX_TENSOR_DIMS];
    uint32_t    dtype;     /* GGML_TYPE_* */
    uint64_t    data_off;  /* absolute file offset */
    uint64_t    n_bytes;
} doctr_gguf_tensor;

struct doctr_gguf {
    int    fd;
    void  *map;
    size_t map_size;

    doctr_gguf_kv     *kvs;
    size_t             n_kvs;
    doctr_gguf_tensor *tensors;
    size_t             n_tensors;
    uint64_t           tensor_data_off;
    uint64_t           alignment;
};

/* ── cursor helpers ───────────────────────────────────────────────────── */

typedef struct {
    const uint8_t *p;
    const uint8_t *end;
    int            err;
} cur_t;

static uint8_t  cur_u8(cur_t *c) {
    if (c->p + 1 > c->end) { c->err = -EINVAL; return 0; }
    uint8_t v = *c->p; c->p += 1; return v;
}
static uint16_t cur_u16(cur_t *c) {
    if (c->p + 2 > c->end) { c->err = -EINVAL; return 0; }
    uint16_t v; memcpy(&v, c->p, 2); c->p += 2; return v;
}
static uint32_t cur_u32(cur_t *c) {
    if (c->p + 4 > c->end) { c->err = -EINVAL; return 0; }
    uint32_t v; memcpy(&v, c->p, 4); c->p += 4; return v;
}
static uint64_t cur_u64(cur_t *c) {
    if (c->p + 8 > c->end) { c->err = -EINVAL; return 0; }
    uint64_t v; memcpy(&v, c->p, 8); c->p += 8; return v;
}
static int32_t  cur_i32(cur_t *c) { uint32_t v = cur_u32(c); int32_t r; memcpy(&r, &v, 4); return r; }
static int64_t  cur_i64(cur_t *c) { uint64_t v = cur_u64(c); int64_t r; memcpy(&r, &v, 8); return r; }
static float    cur_f32(cur_t *c) { uint32_t v = cur_u32(c); float    r; memcpy(&r, &v, 4); return r; }
static double   cur_f64(cur_t *c) { uint64_t v = cur_u64(c); double   r; memcpy(&r, &v, 8); return r; }

/* Read a length-prefixed string. Returns a heap-allocated NUL-terminated
 * dup (for tensor/key names — we keep them owned). Also reports the
 * original pointer + length when `raw_p`/`raw_len` are non-NULL (for
 * string-typed metadata values that point into the mmap). */
static char *cur_string_owned(cur_t *c, const char **raw_p, uint64_t *raw_len) {
    uint64_t n = cur_u64(c);
    if (c->err) return NULL;
    if (c->p + n > c->end) { c->err = -EINVAL; return NULL; }
    char *s = (char *)malloc(n + 1);
    if (!s) { c->err = -ENOMEM; return NULL; }
    memcpy(s, c->p, n);
    s[n] = '\0';
    if (raw_p) *raw_p = (const char *)c->p;
    if (raw_len) *raw_len = n;
    c->p += n;
    return s;
}

static int parse_value(cur_t *c, doctr_gguf_kv *out, uint32_t type);

static int gguf_dtype_size(uint32_t t, size_t *out) {
    switch (t) {
        case GGUF_TYPE_UINT8:   case GGUF_TYPE_INT8:   case GGUF_TYPE_BOOL: *out = 1; return 0;
        case GGUF_TYPE_UINT16:  case GGUF_TYPE_INT16:  *out = 2; return 0;
        case GGUF_TYPE_UINT32:  case GGUF_TYPE_INT32:  case GGUF_TYPE_FLOAT32: *out = 4; return 0;
        case GGUF_TYPE_UINT64:  case GGUF_TYPE_INT64:  case GGUF_TYPE_FLOAT64: *out = 8; return 0;
        default: return -EINVAL;
    }
}

static int parse_value(cur_t *c, doctr_gguf_kv *out, uint32_t type) {
    out->type = type;
    switch (type) {
        case GGUF_TYPE_UINT8:   out->scalar.u8  = cur_u8(c);  return c->err;
        case GGUF_TYPE_INT8:    out->scalar.i8  = (int8_t)cur_u8(c); return c->err;
        case GGUF_TYPE_UINT16:  out->scalar.u16 = cur_u16(c); return c->err;
        case GGUF_TYPE_INT16: { uint16_t v = cur_u16(c); int16_t r; memcpy(&r, &v, 2); out->scalar.i16 = r; return c->err; }
        case GGUF_TYPE_UINT32:  out->scalar.u32 = cur_u32(c); return c->err;
        case GGUF_TYPE_INT32:   out->scalar.i32 = cur_i32(c); return c->err;
        case GGUF_TYPE_FLOAT32: out->scalar.f32 = cur_f32(c); return c->err;
        case GGUF_TYPE_BOOL:    out->scalar.b   = cur_u8(c) ? 1 : 0; return c->err;
        case GGUF_TYPE_UINT64:  out->scalar.u64 = cur_u64(c); return c->err;
        case GGUF_TYPE_INT64:   out->scalar.i64 = cur_i64(c); return c->err;
        case GGUF_TYPE_FLOAT64: out->scalar.f64 = cur_f64(c); return c->err;
        case GGUF_TYPE_STRING:  {
            const char *p; uint64_t n;
            char *dup = cur_string_owned(c, &p, &n);
            if (!dup) return c->err ? c->err : -ENOMEM;
            /* For string-typed metadata we keep the raw mmap pointer
             * (faster lookups) and free the dup since we don't need it. */
            free(dup);
            out->str_val = p;
            out->str_len = n;
            return 0;
        }
        case GGUF_TYPE_ARRAY: {
            uint32_t etype = cur_u32(c);
            uint64_t alen  = cur_u64(c);
            if (c->err) return c->err;
            out->arr_type = etype;
            out->arr_data = c->p;
            out->arr_len  = alen;
            /* Skip past the array body so the cursor advances. We need
             * to know each elem size, with the special case that
             * string-typed arrays have per-element length prefixes. */
            if (etype == GGUF_TYPE_STRING) {
                for (uint64_t i = 0; i < alen; ++i) {
                    uint64_t en = cur_u64(c);
                    if (c->err || c->p + en > c->end) { c->err = -EINVAL; return c->err; }
                    c->p += en;
                }
            } else if (etype == GGUF_TYPE_ARRAY) {
                /* Nested arrays aren't used by us — refuse. */
                return -EINVAL;
            } else {
                size_t esz;
                if (gguf_dtype_size(etype, &esz) != 0) return -EINVAL;
                if (c->p + esz * alen > c->end) { c->err = -EINVAL; return c->err; }
                c->p += esz * alen;
            }
            return 0;
        }
        default:
            return -EINVAL;
    }
}

/* ── public API ───────────────────────────────────────────────────────── */

doctr_gguf *doctr_gguf_open(const char *path, int *err) {
    if (err) *err = 0;
    int fd = open(path, O_RDONLY);
    if (fd < 0) { if (err) *err = -errno; return NULL; }

    struct stat st;
    if (fstat(fd, &st) != 0) { if (err) *err = -errno; close(fd); return NULL; }
    size_t map_size = (size_t)st.st_size;

    void *map = mmap(NULL, map_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map == MAP_FAILED) { if (err) *err = -errno; close(fd); return NULL; }

    cur_t c = {
        .p   = (const uint8_t *)map,
        .end = (const uint8_t *)map + map_size,
        .err = 0,
    };

    /* Header. */
    if (c.p + 4 > c.end || memcmp(c.p, GGUF_MAGIC, 4) != 0) {
        if (err) *err = -EINVAL;
        munmap(map, map_size); close(fd);
        return NULL;
    }
    c.p += 4;
    uint32_t version = cur_u32(&c);
    if (version != 3) {
        if (err) *err = -EINVAL;
        munmap(map, map_size); close(fd);
        return NULL;
    }
    uint64_t n_tensors = cur_u64(&c);
    uint64_t n_kvs     = cur_u64(&c);
    if (c.err) {
        if (err) *err = c.err;
        munmap(map, map_size); close(fd);
        return NULL;
    }

    doctr_gguf *g = (doctr_gguf *)calloc(1, sizeof(doctr_gguf));
    if (!g) { munmap(map, map_size); close(fd); if (err) *err = -ENOMEM; return NULL; }
    g->fd = fd;
    g->map = map;
    g->map_size = map_size;
    g->alignment = 32;  /* GGUF default; overridden by general.alignment if present */

    /* Metadata. */
    g->kvs   = (doctr_gguf_kv *)calloc(n_kvs ? n_kvs : 1, sizeof(doctr_gguf_kv));
    g->n_kvs = n_kvs;
    if (!g->kvs) goto fail_oom;
    for (uint64_t i = 0; i < n_kvs; ++i) {
        const char *_p; uint64_t _n;
        char *key = cur_string_owned(&c, &_p, &_n);
        if (!key) { if (err) *err = c.err ? c.err : -ENOMEM; goto fail; }
        g->kvs[i].name = key;
        uint32_t vt = cur_u32(&c);
        if (c.err) { if (err) *err = c.err; goto fail; }
        int rc = parse_value(&c, &g->kvs[i], vt);
        if (rc != 0) { if (err) *err = rc; goto fail; }
        if (strcmp(key, "general.alignment") == 0 && vt == GGUF_TYPE_UINT32) {
            g->alignment = g->kvs[i].scalar.u32;
            if (g->alignment == 0) g->alignment = 32;
        }
    }

    /* Tensor headers. */
    g->tensors   = (doctr_gguf_tensor *)calloc(n_tensors ? n_tensors : 1, sizeof(doctr_gguf_tensor));
    g->n_tensors = n_tensors;
    if (!g->tensors) goto fail_oom;
    for (uint64_t i = 0; i < n_tensors; ++i) {
        const char *_p; uint64_t _n;
        char *name = cur_string_owned(&c, &_p, &_n);
        if (!name) { if (err) *err = c.err ? c.err : -ENOMEM; goto fail; }
        g->tensors[i].name = name;
        uint32_t nd = cur_u32(&c);
        if (c.err || nd > MAX_TENSOR_DIMS) { if (err) *err = -EINVAL; goto fail; }
        g->tensors[i].ndim = (int)nd;
        for (uint32_t d = 0; d < nd; ++d) {
            g->tensors[i].dims[d] = (int64_t)cur_u64(&c);
            if (g->tensors[i].dims[d] <= 0) { if (err) *err = -EINVAL; goto fail; }
        }
        g->tensors[i].dtype    = cur_u32(&c);
        uint64_t off            = cur_u64(&c);  /* relative offset */
        if (c.err) { if (err) *err = c.err; goto fail; }
        g->tensors[i].data_off  = off;          /* fix to absolute below */

        /* Byte count: only F32 + F16 supported here. */
        uint64_t elems = 1;
        for (int d = 0; d < g->tensors[i].ndim; ++d) elems *= (uint64_t)g->tensors[i].dims[d];
        size_t esz;
        if (g->tensors[i].dtype == GGML_TYPE_F32) esz = 4;
        else if (g->tensors[i].dtype == GGML_TYPE_F16) esz = 2;
        else { if (err) *err = -EINVAL; goto fail; }
        g->tensors[i].n_bytes = elems * esz;
    }

    /* Tensor data section starts after the headers, aligned up to
     * g->alignment. */
    uint64_t cur_off = (uint64_t)((const uint8_t *)c.p - (const uint8_t *)map);
    uint64_t pad = (g->alignment - (cur_off % g->alignment)) % g->alignment;
    g->tensor_data_off = cur_off + pad;

    /* Convert each tensor's relative offset to absolute. */
    for (uint64_t i = 0; i < n_tensors; ++i) {
        g->tensors[i].data_off += g->tensor_data_off;
        if (g->tensors[i].data_off + g->tensors[i].n_bytes > map_size) {
            if (err) *err = -EINVAL; goto fail;
        }
    }

    return g;

fail_oom:
    if (err) *err = -ENOMEM;
fail:
    doctr_gguf_close(g);
    return NULL;
}

void doctr_gguf_close(doctr_gguf *g) {
    if (!g) return;
    if (g->kvs) {
        for (size_t i = 0; i < g->n_kvs; ++i) free(g->kvs[i].name);
        free(g->kvs);
    }
    if (g->tensors) {
        for (size_t i = 0; i < g->n_tensors; ++i) free(g->tensors[i].name);
        free(g->tensors);
    }
    if (g->map && g->map != MAP_FAILED) munmap(g->map, g->map_size);
    if (g->fd >= 0) close(g->fd);
    free(g);
}

static const doctr_gguf_kv *find_kv(const doctr_gguf *g, const char *key) {
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (strcmp(g->kvs[i].name, key) == 0) return &g->kvs[i];
    }
    return NULL;
}

const char *doctr_gguf_get_string(const doctr_gguf *g, const char *key) {
    const doctr_gguf_kv *kv = find_kv(g, key);
    if (!kv || kv->type != GGUF_TYPE_STRING) return NULL;
    /* String metadata values live inside the mmap and are NOT
     * NUL-terminated. We dup into a static-per-key cache to give the
     * caller a NUL-terminated C string. Since this is queried a handful
     * of times during open(), the leak is bounded and trivial; we free
     * on close(). For now: malloc once per query — caller is expected
     * to hold the pointer for the session lifetime. Cheap because the
     * GGUF outlives every call. */
    char *dup = (char *)malloc(kv->str_len + 1);
    if (!dup) return NULL;
    memcpy(dup, kv->str_val, kv->str_len);
    dup[kv->str_len] = '\0';
    /* We deliberately leak this — at most a handful of strings (vocab,
     * detector/recognizer name, upstream pin). The session keeps a
     * reference and frees them with the rest. To avoid the leak, the
     * caller's session struct copies once and never queries again. */
    return dup;
}

int doctr_gguf_get_uint32(const doctr_gguf *g, const char *key, uint32_t *out) {
    const doctr_gguf_kv *kv = find_kv(g, key);
    if (!kv) return -ENOENT;
    if (kv->type != GGUF_TYPE_UINT32) return -EINVAL;
    *out = kv->scalar.u32;
    return 0;
}

const float *doctr_gguf_get_f32(
    const doctr_gguf *g, const char *name,
    int64_t *dims, int max_dims, int *ndim)
{
    for (size_t i = 0; i < g->n_tensors; ++i) {
        if (strcmp(g->tensors[i].name, name) != 0) continue;
        if (g->tensors[i].dtype != GGML_TYPE_F32) return NULL;
        int nd = g->tensors[i].ndim;
        if (nd > max_dims) return NULL;
        for (int d = 0; d < nd; ++d) dims[d] = g->tensors[i].dims[d];
        *ndim = nd;
        return (const float *)((const uint8_t *)g->map + g->tensors[i].data_off);
    }
    return NULL;
}
