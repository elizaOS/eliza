/*
 * Minimal GGUF v3 reader for yolo-cpp Phase 2.
 *
 * Reads the GGUF emitted by scripts/yolo_to_gguf.py:
 *   - arch="yolo"
 *   - F32 + F16 tensors (Conv2D weights are fp16; BN params fp32).
 *   - small set of metadata keys (yolo.detector, yolo.input_size, ...).
 *
 * Unknown tensor dtypes are a hard error — silent acceptance would let
 * a quantized future GGUF load and produce garbage. Phase 3 may layer
 * Q4_POLAR on top; that requires explicit dtype handling here.
 *
 * Layout (GGUF v3, little-endian) — see src/doctr_gguf.c in the sibling
 * doctr-cpp package for the more verbose comment, this is the same
 * format with one extra dtype (F16).
 */

#include "yolo_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* ── GGUF constants we use ─────────────────────────────────────────────── */

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
} yolo_gguf_kv;

typedef struct {
    char       *name;
    int         ndim;
    int64_t     dims[MAX_TENSOR_DIMS];   /* GGUF stores reversed-from-numpy: dims[0] is innermost */
    uint32_t    dtype;     /* GGML_TYPE_* */
    uint64_t    data_off;  /* absolute file offset */
    uint64_t    n_bytes;
    uint64_t    n_elems;
} yolo_gguf_tensor;

struct yolo_gguf {
    int    fd;
    void  *map;
    size_t map_size;

    yolo_gguf_kv     *kvs;
    size_t            n_kvs;
    yolo_gguf_tensor *tensors;
    size_t            n_tensors;
    uint64_t          tensor_data_off;
    uint64_t          alignment;
};

/* ── cursor helpers ────────────────────────────────────────────────────── */

typedef struct {
    const uint8_t *p;
    const uint8_t *end;
    int            err;
} cur_t;

static uint8_t  cur_u8 (cur_t *c) {
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
static int32_t cur_i32(cur_t *c) { uint32_t v = cur_u32(c); int32_t r; memcpy(&r, &v, 4); return r; }
static int64_t cur_i64(cur_t *c) { uint64_t v = cur_u64(c); int64_t r; memcpy(&r, &v, 8); return r; }
static float   cur_f32(cur_t *c) { uint32_t v = cur_u32(c); float    r; memcpy(&r, &v, 4); return r; }
static double  cur_f64(cur_t *c) { uint64_t v = cur_u64(c); double   r; memcpy(&r, &v, 8); return r; }

/* Read length-prefixed string. Returns heap-owned NUL-terminated copy
 * (used for tensor names + KV keys). Also reports the raw mmap pointer
 * + length when caller wants to keep a borrowed view. */
static char *cur_string_owned(cur_t *c, const char **raw_p, uint64_t *raw_len) {
    uint64_t n = cur_u64(c);
    if (c->err) return NULL;
    if (c->p + n > c->end) { c->err = -EINVAL; return NULL; }
    char *s = (char *)malloc(n + 1);
    if (!s) { c->err = -ENOMEM; return NULL; }
    memcpy(s, c->p, n);
    s[n] = '\0';
    if (raw_p)   *raw_p   = (const char *)c->p;
    if (raw_len) *raw_len = n;
    c->p += n;
    return s;
}

static int parse_value(cur_t *c, yolo_gguf_kv *out, uint32_t type);

static int gguf_dtype_size(uint32_t t, size_t *out) {
    switch (t) {
        case GGUF_TYPE_UINT8:  case GGUF_TYPE_INT8:  case GGUF_TYPE_BOOL: *out = 1; return 0;
        case GGUF_TYPE_UINT16: case GGUF_TYPE_INT16: *out = 2; return 0;
        case GGUF_TYPE_UINT32: case GGUF_TYPE_INT32: case GGUF_TYPE_FLOAT32: *out = 4; return 0;
        case GGUF_TYPE_UINT64: case GGUF_TYPE_INT64: case GGUF_TYPE_FLOAT64: *out = 8; return 0;
        default: return -EINVAL;
    }
}

static int parse_value(cur_t *c, yolo_gguf_kv *out, uint32_t type) {
    out->type = type;
    switch (type) {
        case GGUF_TYPE_UINT8:   out->scalar.u8  = cur_u8(c);   return c->err;
        case GGUF_TYPE_INT8:    out->scalar.i8  = (int8_t)cur_u8(c); return c->err;
        case GGUF_TYPE_UINT16:  out->scalar.u16 = cur_u16(c);  return c->err;
        case GGUF_TYPE_INT16: { uint16_t v = cur_u16(c); int16_t r; memcpy(&r, &v, 2); out->scalar.i16 = r; return c->err; }
        case GGUF_TYPE_UINT32:  out->scalar.u32 = cur_u32(c);  return c->err;
        case GGUF_TYPE_INT32:   out->scalar.i32 = cur_i32(c);  return c->err;
        case GGUF_TYPE_FLOAT32: out->scalar.f32 = cur_f32(c);  return c->err;
        case GGUF_TYPE_BOOL:    out->scalar.b   = cur_u8(c) ? 1 : 0; return c->err;
        case GGUF_TYPE_UINT64:  out->scalar.u64 = cur_u64(c);  return c->err;
        case GGUF_TYPE_INT64:   out->scalar.i64 = cur_i64(c);  return c->err;
        case GGUF_TYPE_FLOAT64: out->scalar.f64 = cur_f64(c);  return c->err;
        case GGUF_TYPE_STRING:  {
            const char *p; uint64_t n;
            char *dup = cur_string_owned(c, &p, &n);
            if (!dup) return c->err ? c->err : -ENOMEM;
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
            if (etype == GGUF_TYPE_STRING) {
                for (uint64_t i = 0; i < alen; ++i) {
                    uint64_t en = cur_u64(c);
                    if (c->err || c->p + en > c->end) { c->err = -EINVAL; return c->err; }
                    c->p += en;
                }
            } else if (etype == GGUF_TYPE_ARRAY) {
                return -EINVAL; /* nested arrays not used */
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

/* ── public API ────────────────────────────────────────────────────────── */

yolo_gguf *yolo_gguf_open(const char *path, int *err) {
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

    yolo_gguf *g = (yolo_gguf *)calloc(1, sizeof(yolo_gguf));
    if (!g) { munmap(map, map_size); close(fd); if (err) *err = -ENOMEM; return NULL; }
    g->fd = fd;
    g->map = map;
    g->map_size = map_size;
    g->alignment = 32;

    /* Metadata. */
    g->kvs   = (yolo_gguf_kv *)calloc(n_kvs ? n_kvs : 1, sizeof(yolo_gguf_kv));
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
    g->tensors   = (yolo_gguf_tensor *)calloc(n_tensors ? n_tensors : 1, sizeof(yolo_gguf_tensor));
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
        g->tensors[i].data_off  = off;

        uint64_t elems = 1;
        for (int d = 0; d < g->tensors[i].ndim; ++d) elems *= (uint64_t)g->tensors[i].dims[d];
        g->tensors[i].n_elems = elems;
        size_t esz;
        if      (g->tensors[i].dtype == GGML_TYPE_F32) esz = 4;
        else if (g->tensors[i].dtype == GGML_TYPE_F16) esz = 2;
        else { if (err) *err = -EINVAL; goto fail; }
        g->tensors[i].n_bytes = elems * esz;
    }

    uint64_t cur_off = (uint64_t)((const uint8_t *)c.p - (const uint8_t *)map);
    uint64_t pad = (g->alignment - (cur_off % g->alignment)) % g->alignment;
    g->tensor_data_off = cur_off + pad;

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
    yolo_gguf_close(g);
    return NULL;
}

void yolo_gguf_close(yolo_gguf *g) {
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

static const yolo_gguf_kv *find_kv(const yolo_gguf *g, const char *key) {
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (strcmp(g->kvs[i].name, key) == 0) return &g->kvs[i];
    }
    return NULL;
}

int yolo_gguf_get_string(const yolo_gguf *g, const char *key,
                         char *out, size_t cap, size_t *out_len) {
    const yolo_gguf_kv *kv = find_kv(g, key);
    if (!kv)                          return -ENOENT;
    if (kv->type != GGUF_TYPE_STRING) return -EINVAL;
    if (out_len) *out_len = (size_t)kv->str_len;
    if (out && cap > 0) {
        size_t n = (size_t)kv->str_len < cap - 1 ? (size_t)kv->str_len : cap - 1;
        memcpy(out, kv->str_val, n);
        out[n] = '\0';
        if ((size_t)kv->str_len + 1 > cap) return -ENOSPC;
    }
    return 0;
}

int yolo_gguf_get_uint32(const yolo_gguf *g, const char *key, uint32_t *out) {
    const yolo_gguf_kv *kv = find_kv(g, key);
    if (!kv)                         return -ENOENT;
    if (kv->type != GGUF_TYPE_UINT32) return -EINVAL;
    *out = kv->scalar.u32;
    return 0;
}

int yolo_gguf_get_float32(const yolo_gguf *g, const char *key, float *out) {
    const yolo_gguf_kv *kv = find_kv(g, key);
    if (!kv)                          return -ENOENT;
    if (kv->type != GGUF_TYPE_FLOAT32) return -EINVAL;
    *out = kv->scalar.f32;
    return 0;
}

static const yolo_gguf_tensor *find_tensor(const yolo_gguf *g, const char *name) {
    for (size_t i = 0; i < g->n_tensors; ++i) {
        if (strcmp(g->tensors[i].name, name) == 0) return &g->tensors[i];
    }
    return NULL;
}

const void *yolo_gguf_tensor_data(const yolo_gguf *g, const char *name,
                                  int *out_dtype, int64_t *dims, int max_dims, int *ndim) {
    const yolo_gguf_tensor *t = find_tensor(g, name);
    if (!t) return NULL;
    if (t->ndim > max_dims) return NULL;
    /* Reverse-fill dims so callers see PyTorch-shape order
     * (outer-first). GGUF stores innermost-first so dims[0] is the
     * innermost stride. The converter writes (3,3,3,16) for an OIhw
     * Conv2d weight; we want (16,3,3,3) on read. */
    for (int d = 0; d < t->ndim; ++d) {
        dims[d] = t->dims[t->ndim - 1 - d];
    }
    *ndim = t->ndim;
    if (out_dtype) *out_dtype = (int)t->dtype;
    return (const uint8_t *)g->map + t->data_off;
}

size_t yolo_gguf_tensor_count(const yolo_gguf *g) {
    return g ? g->n_tensors : 0;
}

const char *yolo_gguf_tensor_name(const yolo_gguf *g, size_t i) {
    if (!g || i >= g->n_tensors) return NULL;
    return g->tensors[i].name;
}

/* ── fp16 → fp32 ─────────────────────────────────────────────────────── */

static inline float fp16_to_fp32(uint16_t h) {
    /* IEEE 754 half-precision → single-precision. Branchless. */
    uint32_t sign = (uint32_t)(h & 0x8000) << 16;
    uint32_t exp  = (h >> 10) & 0x1f;
    uint32_t mant = h & 0x3ff;
    uint32_t f;
    if (exp == 0) {
        if (mant == 0) {
            f = sign;  /* +-0 */
        } else {
            /* Subnormal: normalize. */
            int e = -1;
            do { e++; mant <<= 1; } while ((mant & 0x400) == 0);
            mant &= 0x3ff;
            f = sign | ((127 - 15 - e) << 23) | (mant << 13);
        }
    } else if (exp == 31) {
        f = sign | 0x7f800000 | (mant << 13);  /* inf / NaN */
    } else {
        f = sign | ((exp + 127 - 15) << 23) | (mant << 13);
    }
    float out;
    memcpy(&out, &f, 4);
    return out;
}

void yolo_fp16_to_fp32(const void *src, float *dst, size_t n) {
    const uint16_t *s = (const uint16_t *)src;
    for (size_t i = 0; i < n; ++i) dst[i] = fp16_to_fp32(s[i]);
}
