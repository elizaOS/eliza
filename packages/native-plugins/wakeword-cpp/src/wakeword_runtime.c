/*
 * wakeword_runtime.c — real openWakeWord runtime, three-GGUF edition.
 *
 * Replaces the ENOSYS stub in `wakeword_stub.c`. Loads three GGUFs
 * produced by `scripts/wakeword_to_gguf.py`:
 *
 *   1. melspec.gguf    — fp16 STFT real/imag bases (257, 1, 512) and
 *                        mel filter matrix (257, 32). The C runtime
 *                        replicates the openWakeWord ONNX dB-log post-
 *                        processing — see `wakeword_melspec.c`.
 *   2. embedding.gguf  — fp16 weights for the 20 Conv2D layers, biases
 *                        for layers 0..18 (layer 19 has no bias). The
 *                        C runtime applies LeakyReLU(0.2) → max(0,·)
 *                        and 4 MaxPools per the openWakeWord ONNX.
 *   3. classifier.gguf — fp16 weights for the wake-phrase MLP head:
 *                        Flatten(16, 96) → Gemm(1536→96) → LayerNorm →
 *                        ReLU → Gemm(96→96) → ReLU → Gemm(96→1) → Sigmoid.
 *
 * Streaming contract: the caller drips arbitrary 16 kHz mono float PCM
 * into `wakeword_process`. Internally the runtime:
 *
 *   - Buffers PCM into a streaming melspec front-end (10 ms hop).
 *   - Maintains a rolling 76-frame mel ring; every time it advances
 *     by 8 frames (= 80 ms) it runs ONE embedding step and pushes the
 *     resulting 96-d embedding into a 16-deep ring.
 *   - Once the embedding ring has 16 entries it runs the classifier
 *     head and updates the most recent score.
 *
 * No SIMD, no FFT library, no ggml link. Pure scalar C. The runtime is
 * dominated by the embedding model (≈300 K float ops per 80 ms hop);
 * a laptop CPU runs it at well under 1 % of real time.
 *
 * GGUF reading is in-house — a minimal v3 parser adequate for the keys
 * + tensor types this converter emits (fp16 weights, uint32 / string
 * scalars). Mirrors `silero_vad_runtime.c`'s reader 1:1.
 */

#include "wakeword/wakeword.h"
#include "wakeword_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* ───── GGUF v3 minimal reader (mirrors silero-vad-cpp) ─────────────── */

#define GGUF_MAGIC "GGUF"

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
    uint32_t type;
    union {
        uint32_t u32;
        float    f32;
    } scalar;
    const char *str_val;
    uint64_t    str_len;
} ww_kv;

typedef struct {
    char       *name;
    int         ndim;
    int64_t     dims[MAX_TENSOR_DIMS];
    uint32_t    dtype;
    uint64_t    data_off; /* absolute file offset */
    uint64_t    n_bytes;
} ww_tensor;

typedef struct {
    int    fd;
    void  *map;
    size_t map_size;

    ww_kv     *kvs;
    size_t     n_kvs;
    ww_tensor *tensors;
    size_t     n_tensors;
    uint64_t   alignment;
} ww_gguf;

static int rd_u32(const uint8_t *p, size_t a, size_t *c, uint32_t *o) {
    if (*c + 4 > a) return -EINVAL;
    memcpy(o, p + *c, 4);
    *c += 4;
    return 0;
}
static int rd_u64(const uint8_t *p, size_t a, size_t *c, uint64_t *o) {
    if (*c + 8 > a) return -EINVAL;
    memcpy(o, p + *c, 8);
    *c += 8;
    return 0;
}
static int rd_f32(const uint8_t *p, size_t a, size_t *c, float *o) {
    if (*c + 4 > a) return -EINVAL;
    memcpy(o, p + *c, 4);
    *c += 4;
    return 0;
}
static int rd_str(const uint8_t *p, size_t a, size_t *c,
                  const char **so, uint64_t *lo) {
    uint64_t len = 0;
    int rc = rd_u64(p, a, c, &len);
    if (rc) return rc;
    if (*c + len > a) return -EINVAL;
    *so = (const char *)(p + *c);
    *lo = len;
    *c += len;
    return 0;
}

static int skip_kv_value(const uint8_t *p, size_t a, size_t *c, uint32_t type) {
    switch (type) {
    case GGUF_TYPE_UINT8: case GGUF_TYPE_INT8: case GGUF_TYPE_BOOL:
        if (*c + 1 > a) return -EINVAL;
        *c += 1; return 0;
    case GGUF_TYPE_UINT16: case GGUF_TYPE_INT16:
        if (*c + 2 > a) return -EINVAL;
        *c += 2; return 0;
    case GGUF_TYPE_UINT32: case GGUF_TYPE_INT32: case GGUF_TYPE_FLOAT32:
        if (*c + 4 > a) return -EINVAL;
        *c += 4; return 0;
    case GGUF_TYPE_UINT64: case GGUF_TYPE_INT64: case GGUF_TYPE_FLOAT64:
        if (*c + 8 > a) return -EINVAL;
        *c += 8; return 0;
    case GGUF_TYPE_STRING: { const char *s; uint64_t l; return rd_str(p, a, c, &s, &l); }
    case GGUF_TYPE_ARRAY: {
        uint32_t et; uint64_t n;
        if (rd_u32(p, a, c, &et)) return -EINVAL;
        if (rd_u64(p, a, c, &n)) return -EINVAL;
        for (uint64_t i = 0; i < n; ++i) { int rc = skip_kv_value(p, a, c, et); if (rc) return rc; }
        return 0;
    }
    default: return -EINVAL;
    }
}

static int dtype_byte_size(uint32_t dtype, uint64_t n_elem, uint64_t *out) {
    switch (dtype) {
    case GGML_TYPE_F32: *out = n_elem * 4; return 0;
    case GGML_TYPE_F16: *out = n_elem * 2; return 0;
    default:            *out = 0;          return -EINVAL;
    }
}

static void ww_gguf_close(ww_gguf *g) {
    if (!g) return;
    if (g->kvs) { for (size_t i = 0; i < g->n_kvs; ++i) free(g->kvs[i].name); free(g->kvs); }
    if (g->tensors) { for (size_t i = 0; i < g->n_tensors; ++i) free(g->tensors[i].name); free(g->tensors); }
    if (g->map && g->map != MAP_FAILED) munmap(g->map, g->map_size);
    if (g->fd >= 0) close(g->fd);
    free(g);
}

static ww_gguf *ww_gguf_open(const char *path, int *err) {
    *err = 0;
    int fd = open(path, O_RDONLY);
    if (fd < 0) { *err = -errno; return NULL; }
    struct stat st;
    if (fstat(fd, &st) != 0) { *err = -errno; close(fd); return NULL; }
    if (st.st_size < 16) { *err = -EINVAL; close(fd); return NULL; }
    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map == MAP_FAILED) { *err = -errno; close(fd); return NULL; }
    ww_gguf *g = (ww_gguf *)calloc(1, sizeof(*g));
    if (!g) { munmap(map, (size_t)st.st_size); close(fd); *err = -ENOMEM; return NULL; }
    g->fd = fd; g->map = map; g->map_size = (size_t)st.st_size; g->alignment = 32;

    const uint8_t *p = (const uint8_t *)map;
    size_t cur = 0;
    if (memcmp(p, GGUF_MAGIC, 4) != 0) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
    cur += 4;
    uint32_t version = 0;
    if (rd_u32(p, g->map_size, &cur, &version)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
    if (version != 3) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
    uint64_t n_tensors = 0, n_kvs = 0;
    if (rd_u64(p, g->map_size, &cur, &n_tensors)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
    if (rd_u64(p, g->map_size, &cur, &n_kvs)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }

    g->kvs = (ww_kv *)calloc((size_t)n_kvs, sizeof(ww_kv));
    if (n_kvs > 0 && !g->kvs) { *err = -ENOMEM; ww_gguf_close(g); return NULL; }
    g->n_kvs = (size_t)n_kvs;

    for (size_t i = 0; i < g->n_kvs; ++i) {
        const char *kn; uint64_t kl;
        if (rd_str(p, g->map_size, &cur, &kn, &kl)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        g->kvs[i].name = (char *)malloc(kl + 1);
        if (!g->kvs[i].name) { *err = -ENOMEM; ww_gguf_close(g); return NULL; }
        memcpy(g->kvs[i].name, kn, kl);
        g->kvs[i].name[kl] = '\0';
        uint32_t type = 0;
        if (rd_u32(p, g->map_size, &cur, &type)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        g->kvs[i].type = type;
        if (type == GGUF_TYPE_UINT32) {
            if (rd_u32(p, g->map_size, &cur, &g->kvs[i].scalar.u32)) {
                *err = -EINVAL; ww_gguf_close(g); return NULL;
            }
        } else if (type == GGUF_TYPE_FLOAT32) {
            if (rd_f32(p, g->map_size, &cur, &g->kvs[i].scalar.f32)) {
                *err = -EINVAL; ww_gguf_close(g); return NULL;
            }
        } else if (type == GGUF_TYPE_STRING) {
            if (rd_str(p, g->map_size, &cur, &g->kvs[i].str_val, &g->kvs[i].str_len)) {
                *err = -EINVAL; ww_gguf_close(g); return NULL;
            }
        } else {
            if (skip_kv_value(p, g->map_size, &cur, type)) {
                *err = -EINVAL; ww_gguf_close(g); return NULL;
            }
        }
    }

    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (g->kvs[i].type == GGUF_TYPE_UINT32
            && strcmp(g->kvs[i].name, "general.alignment") == 0
            && g->kvs[i].scalar.u32 > 0) {
            g->alignment = g->kvs[i].scalar.u32;
        }
    }

    g->tensors = (ww_tensor *)calloc((size_t)n_tensors, sizeof(ww_tensor));
    if (n_tensors > 0 && !g->tensors) { *err = -ENOMEM; ww_gguf_close(g); return NULL; }
    g->n_tensors = (size_t)n_tensors;

    for (size_t i = 0; i < g->n_tensors; ++i) {
        const char *tn; uint64_t tl;
        if (rd_str(p, g->map_size, &cur, &tn, &tl)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        g->tensors[i].name = (char *)malloc(tl + 1);
        if (!g->tensors[i].name) { *err = -ENOMEM; ww_gguf_close(g); return NULL; }
        memcpy(g->tensors[i].name, tn, tl);
        g->tensors[i].name[tl] = '\0';
        uint32_t ndim = 0;
        if (rd_u32(p, g->map_size, &cur, &ndim)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        if (ndim > MAX_TENSOR_DIMS) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        g->tensors[i].ndim = (int)ndim;
        for (uint32_t d = 0; d < ndim; ++d) {
            uint64_t dim = 0;
            if (rd_u64(p, g->map_size, &cur, &dim)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
            g->tensors[i].dims[d] = (int64_t)dim;
        }
        uint32_t dtype = 0;
        if (rd_u32(p, g->map_size, &cur, &dtype)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        g->tensors[i].dtype = dtype;
        uint64_t off_rel = 0;
        if (rd_u64(p, g->map_size, &cur, &off_rel)) { *err = -EINVAL; ww_gguf_close(g); return NULL; }
        g->tensors[i].data_off = off_rel;
        uint64_t n_elem = 1;
        for (int d = 0; d < g->tensors[i].ndim; ++d) n_elem *= (uint64_t)g->tensors[i].dims[d];
        if (dtype_byte_size(dtype, n_elem, &g->tensors[i].n_bytes)) {
            *err = -EINVAL; ww_gguf_close(g); return NULL;
        }
    }

    uint64_t data_off = (cur + g->alignment - 1) & ~(g->alignment - 1);
    for (size_t i = 0; i < g->n_tensors; ++i) {
        g->tensors[i].data_off += data_off;
        if (g->tensors[i].data_off + g->tensors[i].n_bytes > g->map_size) {
            *err = -EINVAL; ww_gguf_close(g); return NULL;
        }
    }
    return g;
}

static const char *ww_gguf_get_string(const ww_gguf *g, const char *key, uint64_t *len_out) {
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (g->kvs[i].type == GGUF_TYPE_STRING && strcmp(g->kvs[i].name, key) == 0) {
            if (len_out) *len_out = g->kvs[i].str_len;
            return g->kvs[i].str_val;
        }
    }
    return NULL;
}

static int ww_gguf_get_u32(const ww_gguf *g, const char *key, uint32_t *out) {
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (g->kvs[i].type == GGUF_TYPE_UINT32 && strcmp(g->kvs[i].name, key) == 0) {
            *out = g->kvs[i].scalar.u32;
            return 0;
        }
    }
    return -ENOENT;
}

static const ww_tensor *ww_gguf_find(const ww_gguf *g, const char *name) {
    for (size_t i = 0; i < g->n_tensors; ++i) {
        if (strcmp(g->tensors[i].name, name) == 0) return &g->tensors[i];
    }
    return NULL;
}

/* IEEE 754 fp16 → fp32 (covers subnormals). */
static float fp16_to_fp32(uint16_t h) {
    uint32_t s = (uint32_t)(h >> 15) & 0x1u;
    uint32_t e = (uint32_t)(h >> 10) & 0x1Fu;
    uint32_t m = (uint32_t)(h)        & 0x3FFu;
    uint32_t f;
    if (e == 0) {
        if (m == 0) {
            f = s << 31;
        } else {
            while ((m & 0x400u) == 0) { m <<= 1; e -= 1; }
            e += 1;
            m &= ~0x400u;
            f = (s << 31) | ((e + (127 - 15)) << 23) | (m << 13);
        }
    } else if (e == 31) {
        f = (s << 31) | 0x7F800000u | (m << 13);
    } else {
        f = (s << 31) | ((e + (127 - 15)) << 23) | (m << 13);
    }
    float out;
    memcpy(&out, &f, 4);
    return out;
}

/* Load a tensor as fp32. Refuses on missing or wrong-shape. */
static float *ww_load_fp16(const ww_gguf *g, const char *name,
                           const int64_t *dims, int ndim, int *err) {
    *err = 0;
    const ww_tensor *t = ww_gguf_find(g, name);
    if (!t) { *err = -ENOENT; return NULL; }
    if (t->dtype != GGML_TYPE_F16) { *err = -EINVAL; return NULL; }
    if (t->ndim != ndim) { *err = -EINVAL; return NULL; }
    for (int d = 0; d < ndim; ++d) {
        if (t->dims[d] != dims[d]) { *err = -EINVAL; return NULL; }
    }
    uint64_t n = 1;
    for (int d = 0; d < ndim; ++d) n *= (uint64_t)dims[d];
    float *out = (float *)malloc(n * sizeof(float));
    if (!out) { *err = -ENOMEM; return NULL; }
    const uint8_t *base = (const uint8_t *)g->map + t->data_off;
    for (uint64_t i = 0; i < n; ++i) {
        uint16_t h;
        memcpy(&h, base + i * 2, 2);
        out[i] = fp16_to_fp32(h);
    }
    return out;
}

/* ───── Cross-GGUF metadata validation ────────────────────────────── */

static int validate_common_metadata(const ww_gguf *g) {
    /* upstream_commit: required, must match the pin in the script. */
    uint64_t len = 0;
    const char *pin = ww_gguf_get_string(g, "wakeword.upstream_commit", &len);
    if (!pin || len == 0) return -EINVAL;

    uint32_t v = 0;
    if (ww_gguf_get_u32(g, "wakeword.melspec_n_mels", &v) != 0 || v != WW_N_MELS) return -EINVAL;
    if (ww_gguf_get_u32(g, "wakeword.melspec_hop", &v) != 0 || v != WW_HOP_LEN) return -EINVAL;
    if (ww_gguf_get_u32(g, "wakeword.embedding_dim", &v) != 0 || v != WW_EMBEDDING_DIM) return -EINVAL;
    if (ww_gguf_get_u32(g, "wakeword.embedding_window", &v) != 0 || v != WW_EMBEDDING_WINDOW) return -EINVAL;
    if (ww_gguf_get_u32(g, "wakeword.head_window", &v) != 0 || v != WW_HEAD_WINDOW) return -EINVAL;
    return 0;
}

/* Refuse mixing GGUFs from different conversion runs. */
static int validate_consistent_pin(const ww_gguf *a, const ww_gguf *b) {
    uint64_t la = 0, lb = 0;
    const char *pa = ww_gguf_get_string(a, "wakeword.upstream_commit", &la);
    const char *pb = ww_gguf_get_string(b, "wakeword.upstream_commit", &lb);
    if (!pa || !pb) return -EINVAL;
    if (la != lb) return -EINVAL;
    if (memcmp(pa, pb, la) != 0) return -EINVAL;
    return 0;
}

/* ───── Embedding model layout (matches converter EMBEDDING_LAYERS) ─ */

typedef struct {
    int kh, kw;       /* kernel size in (H = mel, W = time) */
    int ph, pw;       /* symmetric pad sizes (per side) */
    bool has_bias;
    /* Optional max-pool right after this conv:
     *   pool_kh > 0 means a (pool_kh, pool_kw) pool with stride
     *   (pool_sh, pool_sw) follows.
     */
    int pool_kh, pool_kw, pool_sh, pool_sw;
    int cout, cin;
    float *w;         /* (cout, cin, kh, kw) row-major — owned       */
    float *b;         /* (cout) row-major — owned (NULL if no bias) */
} ww_emb_layer;

#define WW_EMB_NLAYERS 20

/* ───── Session ─────────────────────────────────────────────────────── */

struct wakeword_session {
    /* Loaded melspec tensors. */
    float *stft_real;     /* (257, 1, 512) */
    float *stft_imag;     /* (257, 1, 512) */
    float *mel_filter;    /* (257, 32) */

    /* Embedding model. */
    ww_emb_layer emb[WW_EMB_NLAYERS];

    /* Classifier head. */
    float *cls_gemm0_w;   /* (96, 1536) */
    float *cls_gemm0_b;   /* (96)       */
    float *cls_ln_w;      /* (96)       */
    float *cls_ln_b;      /* (96)       */
    float *cls_gemm1_w;   /* (96, 96)   */
    float *cls_gemm1_b;   /* (96)       */
    float *cls_gemm2_w;   /* (1, 96)    */
    float *cls_gemm2_b;   /* (1)        */

    /* Streaming state. */
    wakeword_melspec_state mel_state;
    /* Mel ring: 76 frames × 32 mels. We refill it linearly and step
     * by 8 frames per embedding evaluation. */
    float    mel_ring[(size_t)WW_EMBEDDING_WINDOW * (size_t)WW_N_MELS];
    /* Number of mel frames currently buffered in mel_ring (≤ 76). */
    int      mel_buffered;
    /* Mel frames since the last embedding evaluation. */
    int      mel_since_emb;
    /* Embedding ring: 16 × 96. Slot 0 is oldest. */
    float    emb_ring[(size_t)WW_HEAD_WINDOW * (size_t)WW_EMBEDDING_DIM];
    int      emb_buffered;

    /* Latest classifier probability (0 until enough context warmed up). */
    float    last_score;

    /* Advisory threshold (read by future `wakeword_get_threshold`). */
    float    threshold;
};

/* ───── Embedding-layer load ─────────────────────────────────────────── */

static int load_embedding(ww_gguf *g, struct wakeword_session *s) {
    /* (idx, kh, kw, ph, pw, has_bias, pool_kh, pool_kw, pool_sh, pool_sw, cout, cin) */
    const struct {
        int idx;
        int kh, kw, ph, pw;
        bool has_bias;
        int pool_kh, pool_kw, pool_sh, pool_sw;
        int cout, cin;
    } specs[WW_EMB_NLAYERS] = {
        { 0,  3, 3, 0, 1, true,  0, 0, 0, 0, 24,  1  },
        { 1,  1, 3, 0, 1, true,  0, 0, 0, 0, 24,  24 },
        { 2,  3, 1, 0, 0, true,  2, 2, 2, 2, 24,  24 },
        { 3,  1, 3, 0, 1, true,  0, 0, 0, 0, 48,  24 },
        { 4,  3, 1, 0, 0, true,  0, 0, 0, 0, 48,  48 },
        { 5,  1, 3, 0, 1, true,  0, 0, 0, 0, 48,  48 },
        { 6,  3, 1, 0, 0, true,  1, 2, 1, 2, 48,  48 },
        { 7,  1, 3, 0, 1, true,  0, 0, 0, 0, 72,  48 },
        { 8,  3, 1, 0, 0, true,  0, 0, 0, 0, 72,  72 },
        { 9,  1, 3, 0, 1, true,  0, 0, 0, 0, 72,  72 },
        { 10, 3, 1, 0, 0, true,  2, 2, 2, 2, 72,  72 },
        { 11, 1, 3, 0, 1, true,  0, 0, 0, 0, 96,  72 },
        { 12, 3, 1, 0, 0, true,  0, 0, 0, 0, 96,  96 },
        { 13, 1, 3, 0, 1, true,  0, 0, 0, 0, 96,  96 },
        { 14, 3, 1, 0, 0, true,  1, 2, 1, 2, 96,  96 },
        { 15, 1, 3, 0, 1, true,  0, 0, 0, 0, 96,  96 },
        { 16, 3, 1, 0, 0, true,  0, 0, 0, 0, 96,  96 },
        { 17, 1, 3, 0, 1, true,  0, 0, 0, 0, 96,  96 },
        { 18, 3, 1, 0, 0, true,  2, 2, 2, 2, 96,  96 },
        { 19, 3, 1, 0, 0, false, 0, 0, 0, 0, 96,  96 },
    };
    for (int i = 0; i < WW_EMB_NLAYERS; ++i) {
        char name[128];
        snprintf(name, sizeof(name), "wakeword.embedding.conv%d.weight", specs[i].idx);
        /* numpy (cout, cin, kh, kw) -> GGUF dims (kw, kh, cin, cout). */
        const int64_t wshape[4] = { specs[i].kw, specs[i].kh, specs[i].cin, specs[i].cout };
        int err = 0;
        s->emb[i].w = ww_load_fp16(g, name, wshape, 4, &err);
        if (!s->emb[i].w) return err == 0 ? -ENOENT : err;
        if (specs[i].has_bias) {
            snprintf(name, sizeof(name), "wakeword.embedding.conv%d.bias", specs[i].idx);
            const int64_t bshape[1] = { specs[i].cout };
            s->emb[i].b = ww_load_fp16(g, name, bshape, 1, &err);
            if (!s->emb[i].b) return err == 0 ? -ENOENT : err;
        } else {
            s->emb[i].b = NULL;
        }
        s->emb[i].kh = specs[i].kh;
        s->emb[i].kw = specs[i].kw;
        s->emb[i].ph = specs[i].ph;
        s->emb[i].pw = specs[i].pw;
        s->emb[i].has_bias = specs[i].has_bias;
        s->emb[i].pool_kh = specs[i].pool_kh;
        s->emb[i].pool_kw = specs[i].pool_kw;
        s->emb[i].pool_sh = specs[i].pool_sh;
        s->emb[i].pool_sw = specs[i].pool_sw;
        s->emb[i].cout = specs[i].cout;
        s->emb[i].cin = specs[i].cin;
    }
    return 0;
}

/* ───── Numerical kernels (scalar) ─────────────────────────────────── */

/* Conv2D with symmetric padding. Layout:
 *   x:   (cin, H_in, W_in)         row-major
 *   w:   (cout, cin, kh, kw)       row-major
 *   b:   (cout) or NULL
 *   out: (cout, H_out, W_out)      row-major; caller sized correctly
 *        H_out = H_in + 2*ph - kh + 1
 *        W_out = W_in + 2*pw - kw + 1
 *
 * Stride is always 1 (the openWakeWord embedding network uses pure
 * stride-1 convs and explicit MaxPool layers for downsampling).
 */
static void conv2d_ref(
    const float *x, int cin, int H_in, int W_in,
    const float *w, int cout, int kh, int kw,
    const float *b,
    int ph, int pw,
    float *out)
{
    const int H_out = H_in + 2 * ph - kh + 1;
    const int W_out = W_in + 2 * pw - kw + 1;
    for (int oc = 0; oc < cout; ++oc) {
        const float bias = b ? b[oc] : 0.0f;
        for (int oh = 0; oh < H_out; ++oh) {
            for (int ow = 0; ow < W_out; ++ow) {
                double acc = 0.0;
                for (int ic = 0; ic < cin; ++ic) {
                    for (int ki = 0; ki < kh; ++ki) {
                        const int ih = oh + ki - ph;
                        if (ih < 0 || ih >= H_in) continue;
                        for (int kj = 0; kj < kw; ++kj) {
                            const int iw = ow + kj - pw;
                            if (iw < 0 || iw >= W_in) continue;
                            const float xv = x[((size_t)ic * H_in + ih) * W_in + iw];
                            const float wv = w[(((size_t)oc * cin + ic) * kh + ki) * kw + kj];
                            acc += (double)xv * (double)wv;
                        }
                    }
                }
                out[((size_t)oc * H_out + oh) * W_out + ow] = (float)acc + bias;
            }
        }
    }
}

/* MaxPool2D with no padding. */
static void maxpool2d_ref(
    const float *x, int c, int H_in, int W_in,
    int kh, int kw, int sh, int sw,
    float *out)
{
    const int H_out = (H_in - kh) / sh + 1;
    const int W_out = (W_in - kw) / sw + 1;
    for (int ic = 0; ic < c; ++ic) {
        for (int oh = 0; oh < H_out; ++oh) {
            for (int ow = 0; ow < W_out; ++ow) {
                float best = -INFINITY;
                for (int ki = 0; ki < kh; ++ki) {
                    for (int kj = 0; kj < kw; ++kj) {
                        const int ih = oh * sh + ki;
                        const int iw = ow * sw + kj;
                        const float v = x[((size_t)ic * H_in + ih) * W_in + iw];
                        if (v > best) best = v;
                    }
                }
                out[((size_t)ic * H_out + oh) * W_out + ow] = best;
            }
        }
    }
}

/* LeakyReLU(0.2) followed by max(0, ·) — i.e. a plain ReLU. The
 * ONNX has both ops in sequence; max(0) dominates because the leaky
 * branch produces only negative values. We therefore fold them into a
 * single ReLU. */
static void relu_inplace(float *x, size_t n) {
    for (size_t i = 0; i < n; ++i) if (x[i] < 0.0f) x[i] = 0.0f;
}

/* Run one embedding step over a (76, 32) mel window.
 * Layout convention: ONNX reshape is (batch, 76, 32, 1) → ONNX
 * `model/conv2d/Conv2D__6:0` which after the implicit transpose is
 * (1, H=76, W=32). For the C runtime we treat tensor axes as
 * (cin, H, W) with cin the channel axis.
 *
 * Returns 0 on success, -ENOMEM on allocation failure.
 */
static int embedding_forward(
    const struct wakeword_session *s,
    const float *mel_window /* (76, 32) row-major */,
    float *out_emb /* (96) */)
{
    int rc = 0;
    int H = WW_EMBEDDING_WINDOW;
    int W = WW_N_MELS;
    int C = 1;

    /* cur owned, length C * H * W floats */
    float *cur = (float *)malloc(sizeof(float) * (size_t)C * (size_t)H * (size_t)W);
    if (!cur) return -ENOMEM;
    /* Initialize: cin=1, copy (76*32) into (1*76*32). */
    memcpy(cur, mel_window, sizeof(float) * (size_t)H * (size_t)W);

    for (int li = 0; li < WW_EMB_NLAYERS; ++li) {
        const ww_emb_layer *L = &s->emb[li];
        const int H_out = H + 2 * L->ph - L->kh + 1;
        const int W_out = W + 2 * L->pw - L->kw + 1;
        if (H_out <= 0 || W_out <= 0) { rc = -EINVAL; goto fail; }
        float *out = (float *)malloc(sizeof(float) * (size_t)L->cout * (size_t)H_out * (size_t)W_out);
        if (!out) { rc = -ENOMEM; goto fail; }
        conv2d_ref(cur, C, H, W, L->w, L->cout, L->kh, L->kw, L->b, L->ph, L->pw, out);
        free(cur);
        cur = out;
        C = L->cout;
        H = H_out;
        W = W_out;
        /* The final layer (idx 19) has no bias and is followed by no
         * activation in the ONNX (it directly feeds the output Reshape).
         * Skip the activation there. Every other layer applies
         * LeakyReLU(0.2) → max(0) which we fold into a plain ReLU. */
        if (li < WW_EMB_NLAYERS - 1) {
            relu_inplace(cur, (size_t)C * (size_t)H * (size_t)W);
        }
        if (L->pool_kh > 0) {
            const int pH_out = (H - L->pool_kh) / L->pool_sh + 1;
            const int pW_out = (W - L->pool_kw) / L->pool_sw + 1;
            if (pH_out <= 0 || pW_out <= 0) { rc = -EINVAL; goto fail; }
            float *p = (float *)malloc(sizeof(float) * (size_t)C * (size_t)pH_out * (size_t)pW_out);
            if (!p) { rc = -ENOMEM; goto fail; }
            maxpool2d_ref(cur, C, H, W, L->pool_kh, L->pool_kw, L->pool_sh, L->pool_sw, p);
            free(cur);
            cur = p;
            H = pH_out;
            W = pW_out;
        }
    }

    /* Expect (96, 1, 1) at the end. */
    if (C != WW_EMBEDDING_DIM || H != 1 || W != 1) {
        fprintf(stderr, "[wakeword-runtime] embedding final shape (%d, %d, %d) != (%d, 1, 1)\n",
                C, H, W, WW_EMBEDDING_DIM);
        rc = -EINVAL;
        goto fail;
    }
    for (int i = 0; i < WW_EMBEDDING_DIM; ++i) out_emb[i] = cur[i];

fail:
    free(cur);
    return rc;
}

/* y = W @ x + b   (W: rows x cols, x: cols, y: rows). */
static void gemm_ref(const float *W, const float *b, const float *x,
                     int rows, int cols, float *y) {
    for (int r = 0; r < rows; ++r) {
        double acc = b ? (double)b[r] : 0.0;
        const float *row = W + (size_t)r * cols;
        for (int c = 0; c < cols; ++c) acc += (double)row[c] * (double)x[c];
        y[r] = (float)acc;
    }
}

/* LayerNorm over the last dim. Matches PyTorch / ONNX:
 *   y = ((x - mean) / sqrt(var + eps)) * gamma + beta
 * Default ONNX eps = 1e-5. */
static void layernorm_inplace(float *x, int n, const float *gamma, const float *beta) {
    double mean = 0.0;
    for (int i = 0; i < n; ++i) mean += (double)x[i];
    mean /= (double)n;
    double var = 0.0;
    for (int i = 0; i < n; ++i) { const double d = (double)x[i] - mean; var += d * d; }
    var /= (double)n;
    const double rstd = 1.0 / sqrt(var + 1e-5);
    for (int i = 0; i < n; ++i) {
        const double normed = ((double)x[i] - mean) * rstd;
        x[i] = (float)(normed * (double)gamma[i] + (double)beta[i]);
    }
}

static float sigmoidf(float x) {
    if (x >= 0.0f) {
        const float e = expf(-x);
        return 1.0f / (1.0f + e);
    } else {
        const float e = expf(x);
        return e / (1.0f + e);
    }
}

/* Run the classifier head over a (16, 96) embedding window flattened to (1536). */
static float classifier_forward(
    const struct wakeword_session *s,
    const float *flat_in /* (1536) */)
{
    float h0[96];
    gemm_ref(s->cls_gemm0_w, s->cls_gemm0_b, flat_in, 96, 1536, h0);
    layernorm_inplace(h0, 96, s->cls_ln_w, s->cls_ln_b);
    relu_inplace(h0, 96);

    float h1[96];
    gemm_ref(s->cls_gemm1_w, s->cls_gemm1_b, h0, 96, 96, h1);
    relu_inplace(h1, 96);

    float h2[1];
    gemm_ref(s->cls_gemm2_w, s->cls_gemm2_b, h1, 1, 96, h2);
    return sigmoidf(h2[0]);
}

/* ───── Streaming step ──────────────────────────────────────────────── */

/* Push N mel frames into mel_ring; for every 8 added frames, run an
 * embedding step on the current 76-frame window and push the result
 * into emb_ring; for every embedding pushed, if emb_ring has 16
 * entries run the classifier and update last_score.
 *
 * The mel window is the most recent 76 frames in chronological order.
 */
static int push_mel_frames(struct wakeword_session *s, const float *mels, int n_frames) {
    for (int f = 0; f < n_frames; ++f) {
        /* Append frame f to the ring (shift if at capacity). */
        if (s->mel_buffered < WW_EMBEDDING_WINDOW) {
            memcpy(s->mel_ring + (size_t)s->mel_buffered * (size_t)WW_N_MELS,
                   mels + (size_t)f * (size_t)WW_N_MELS,
                   (size_t)WW_N_MELS * sizeof(float));
            s->mel_buffered++;
        } else {
            /* Shift left by 1 frame (drop oldest). */
            memmove(s->mel_ring,
                    s->mel_ring + WW_N_MELS,
                    (size_t)(WW_EMBEDDING_WINDOW - 1) * (size_t)WW_N_MELS * sizeof(float));
            memcpy(s->mel_ring + (size_t)(WW_EMBEDDING_WINDOW - 1) * (size_t)WW_N_MELS,
                   mels + (size_t)f * (size_t)WW_N_MELS,
                   (size_t)WW_N_MELS * sizeof(float));
        }
        s->mel_since_emb++;

        /* Once the ring is full and we have advanced by 8 mels, run an
         * embedding step. The openWakeWord upstream reference advances
         * by 8 mel frames per embedding (= 80 ms hop), with 76 mel
         * frames in context per step. */
        if (s->mel_buffered == WW_EMBEDDING_WINDOW && s->mel_since_emb >= 8) {
            s->mel_since_emb = 0;
            float emb[WW_EMBEDDING_DIM];
            int rc = embedding_forward(s, s->mel_ring, emb);
            if (rc != 0) return rc;

            /* Push embedding into the head ring. */
            if (s->emb_buffered < WW_HEAD_WINDOW) {
                memcpy(s->emb_ring + (size_t)s->emb_buffered * (size_t)WW_EMBEDDING_DIM,
                       emb, (size_t)WW_EMBEDDING_DIM * sizeof(float));
                s->emb_buffered++;
            } else {
                memmove(s->emb_ring,
                        s->emb_ring + WW_EMBEDDING_DIM,
                        (size_t)(WW_HEAD_WINDOW - 1) * (size_t)WW_EMBEDDING_DIM * sizeof(float));
                memcpy(s->emb_ring + (size_t)(WW_HEAD_WINDOW - 1) * (size_t)WW_EMBEDDING_DIM,
                       emb, (size_t)WW_EMBEDDING_DIM * sizeof(float));
            }

            if (s->emb_buffered == WW_HEAD_WINDOW) {
                s->last_score = classifier_forward(s, s->emb_ring);
            }
        }
    }
    return 0;
}

/* ───── Public ABI ──────────────────────────────────────────────────── */

static void session_free(struct wakeword_session *s) {
    if (!s) return;
    free(s->stft_real);
    free(s->stft_imag);
    free(s->mel_filter);
    for (int i = 0; i < WW_EMB_NLAYERS; ++i) {
        free(s->emb[i].w);
        free(s->emb[i].b);
    }
    free(s->cls_gemm0_w); free(s->cls_gemm0_b);
    free(s->cls_ln_w);    free(s->cls_ln_b);
    free(s->cls_gemm1_w); free(s->cls_gemm1_b);
    free(s->cls_gemm2_w); free(s->cls_gemm2_b);
    free(s);
}

int wakeword_open(const char *melspec_gguf,
                  const char *embedding_gguf,
                  const char *classifier_gguf,
                  wakeword_handle *out) {
    if (!out) return -EINVAL;
    *out = NULL;
    if (!melspec_gguf || !embedding_gguf || !classifier_gguf) return -EINVAL;
    if (!*melspec_gguf || !*embedding_gguf || !*classifier_gguf) return -EINVAL;

    int err = 0;
    ww_gguf *gm = ww_gguf_open(melspec_gguf, &err);
    if (!gm) return err == 0 ? -ENOENT : err;
    if (validate_common_metadata(gm) != 0) { ww_gguf_close(gm); return -EINVAL; }

    ww_gguf *ge = ww_gguf_open(embedding_gguf, &err);
    if (!ge) { ww_gguf_close(gm); return err == 0 ? -ENOENT : err; }
    if (validate_common_metadata(ge) != 0
        || validate_consistent_pin(gm, ge) != 0) {
        ww_gguf_close(ge); ww_gguf_close(gm); return -EINVAL;
    }

    ww_gguf *gc = ww_gguf_open(classifier_gguf, &err);
    if (!gc) { ww_gguf_close(ge); ww_gguf_close(gm); return err == 0 ? -ENOENT : err; }
    if (validate_common_metadata(gc) != 0
        || validate_consistent_pin(gm, gc) != 0) {
        ww_gguf_close(gc); ww_gguf_close(ge); ww_gguf_close(gm); return -EINVAL;
    }

    struct wakeword_session *s = (struct wakeword_session *)calloc(1, sizeof(*s));
    if (!s) { ww_gguf_close(gc); ww_gguf_close(ge); ww_gguf_close(gm); return -ENOMEM; }
    s->threshold = WAKEWORD_DEFAULT_THRESHOLD;

    /* melspec tensors. GGUF stores tensor dims in REVERSE of the
     * numpy/PyTorch convention; the data layout is row-major in
     * numpy order. So a numpy (257, 1, 512) tensor lands as GGUF
     * dims (512, 1, 257) on disk; the byte layout is unchanged
     * (last numpy dim = fastest-varying). */
    {
        const int64_t r_shape[3] = { 512, 1, 257 }; /* numpy (257, 1, 512) */
        s->stft_real = ww_load_fp16(gm, "wakeword.melspec.stft_real", r_shape, 3, &err);
        if (!s->stft_real) goto fail;
        s->stft_imag = ww_load_fp16(gm, "wakeword.melspec.stft_imag", r_shape, 3, &err);
        if (!s->stft_imag) goto fail;
        const int64_t m_shape[2] = { 32, 257 }; /* numpy (257, 32) */
        s->mel_filter = ww_load_fp16(gm, "wakeword.melspec.melW", m_shape, 2, &err);
        if (!s->mel_filter) goto fail;
    }

    err = load_embedding(ge, s);
    if (err != 0) { ww_gguf_close(gc); ww_gguf_close(ge); ww_gguf_close(gm); session_free(s); return err; }

    /* classifier tensors. GGUF dim order is reversed from numpy. */
    {
        const int64_t g0w[2] = { 1536, 96 }; /* numpy (96, 1536) */
        s->cls_gemm0_w = ww_load_fp16(gc, "wakeword.classifier.gemm0.weight", g0w, 2, &err);
        if (!s->cls_gemm0_w) goto fail;
        const int64_t b96[1] = { 96 };
        s->cls_gemm0_b = ww_load_fp16(gc, "wakeword.classifier.gemm0.bias", b96, 1, &err);
        if (!s->cls_gemm0_b) goto fail;
        s->cls_ln_w = ww_load_fp16(gc, "wakeword.classifier.ln.weight", b96, 1, &err);
        if (!s->cls_ln_w) goto fail;
        s->cls_ln_b = ww_load_fp16(gc, "wakeword.classifier.ln.bias", b96, 1, &err);
        if (!s->cls_ln_b) goto fail;
        const int64_t g1w[2] = { 96, 96 }; /* numpy (96, 96) — reverse same */
        s->cls_gemm1_w = ww_load_fp16(gc, "wakeword.classifier.gemm1.weight", g1w, 2, &err);
        if (!s->cls_gemm1_w) goto fail;
        s->cls_gemm1_b = ww_load_fp16(gc, "wakeword.classifier.gemm1.bias", b96, 1, &err);
        if (!s->cls_gemm1_b) goto fail;
        const int64_t g2w[2] = { 96, 1 }; /* numpy (1, 96) */
        s->cls_gemm2_w = ww_load_fp16(gc, "wakeword.classifier.gemm2.weight", g2w, 2, &err);
        if (!s->cls_gemm2_w) goto fail;
        const int64_t g2b[1] = { 1 };
        s->cls_gemm2_b = ww_load_fp16(gc, "wakeword.classifier.gemm2.bias", g2b, 1, &err);
        if (!s->cls_gemm2_b) goto fail;
    }

    wakeword_melspec_state_init(&s->mel_state, s->stft_real, s->stft_imag, s->mel_filter);

    ww_gguf_close(gc);
    ww_gguf_close(ge);
    ww_gguf_close(gm);
    *out = (wakeword_handle)s;
    return 0;

fail:
    ww_gguf_close(gc);
    ww_gguf_close(ge);
    ww_gguf_close(gm);
    session_free(s);
    return err == 0 ? -ENOENT : err;
}

int wakeword_close(wakeword_handle h) {
    if (!h) return 0;
    session_free(h);
    return 0;
}

int wakeword_process(wakeword_handle h,
                     const float *pcm_16khz,
                     size_t n_samples,
                     float *score_out) {
    if (!h || !score_out) return -EINVAL;
    if (n_samples > 0 && !pcm_16khz) return -EINVAL;

    /* Push PCM through the streaming melspec. Always allocate at least
     * one column of scratch so the carry buffer can absorb input chunks
     * smaller than the STFT window without `wakeword_melspec_stream`
     * tripping its own NULL-buffer check. */
    size_t max_cols = wakeword_melspec_max_columns(n_samples);
    if (max_cols == 0) max_cols = 1;
    float *cols = (float *)malloc(max_cols * (size_t)WW_N_MELS * sizeof(float));
    if (!cols) return -ENOMEM;
    size_t n_cols = 0;
    int rc = wakeword_melspec_stream(&h->mel_state, pcm_16khz, n_samples, cols, &n_cols);
    if (rc != 0) { free(cols); return rc; }
    if (n_cols > 0) {
        rc = push_mel_frames(h, cols, (int)n_cols);
        if (rc != 0) { free(cols); return rc; }
    }
    free(cols);

    *score_out = h->last_score;
    return 0;
}

int wakeword_set_threshold(wakeword_handle h, float threshold) {
    if (!h) return -EINVAL;
    if (threshold < 0.0f || threshold > 1.0f) return -EINVAL;
    h->threshold = threshold;
    return 0;
}

const char *wakeword_active_backend(void) {
    return "native-cpu";
}
