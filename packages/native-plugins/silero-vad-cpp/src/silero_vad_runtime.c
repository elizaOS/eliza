/*
 * silero-vad-cpp — real model runtime (Phase 2).
 *
 * Replaces the ENOSYS stub in `silero_vad_stub.c`. Loads a GGUF
 * produced by `scripts/silero_vad_to_gguf.py` and runs the Silero v5
 * (16 kHz) graph end-to-end in pure C — no SIMD, no third-party math
 * library, no ggml link. Per-window cost is small enough on a laptop
 * CPU that real-time stays comfortably below 1% of the 32 ms hop.
 *
 * Architecture (matches the converter; see
 * `scripts/silero_vad_to_gguf.py` for the rationale and tensor names):
 *
 *   1. Reflection-pad the 512-sample input by `STFT_PAD=32` on each
 *      side → 576 samples.
 *   2. STFT front-end: Conv1D(1→130, k=128, s=64) on the padded buffer
 *      → (130, 8) frames. The first 65 channels are the "real" basis,
 *      the next 65 are the "imag" basis. Magnitude
 *      `sqrt(real^2 + imag^2)` collapses to (65, 8).
 *   3. Encoder: 4 stacked Conv1D + bias + ReLU. Stride layout
 *      (1, 2, 2, 1) takes the 8-frame STFT output to 2 frames at
 *      128 channels.
 *   4. LSTM (PyTorch convention, gate order i, f, g, o): 2 timesteps
 *      per window, hidden_dim=128, threading recurrent state across
 *      windows via `silero_vad_state_t` (h_in, c_in → h_out, c_out).
 *      The per-window output is the LSTM hidden state at the *last*
 *      timestep.
 *   5. Output head: ReLU(h) → 1×1 Conv (128 → 1) → bias → sigmoid.
 *      The final scalar is the speech probability in [0, 1].
 *
 * GGUF reading is in-house (no link to libgguf) — a minimal v3 parser
 * adequate for the keys + tensor types this converter emits (fp16
 * weights, uint32 / string scalars). Unknown dtype is a hard error.
 *
 * `silero_vad_active_backend()` returns `"native-cpu"` — honest about
 * what this build is. The diagnostic field is reserved for swapping in
 * a SIMD or ggml dispatcher in a later pass without touching callers.
 */

#include "silero_vad/silero_vad.h"
#include "silero_vad_state.h"

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

/* ── Geometry constants (must match the converter) ─────────────────── */

#define VAD_STFT_FILTER_LENGTH 256
#define VAD_STFT_HOP           128
/* Context = the last `VAD_CONTEXT_SAMPLES` samples of the previous
 * window, prepended to the current window before STFT. This mirrors
 * the upstream OnnxWrapper (utils_vad.py): each window the wrapper
 * passes to the model is `[prev_last_64, current_512] = 576`
 * samples; without it the model's STFT loses the carry it was
 * trained against and the per-window prob drifts from the reference
 * by 0.1+ on speech-like inputs. The C runtime owns this context as
 * part of `silero_vad_session`. */
#define VAD_CONTEXT_SAMPLES     64
#define VAD_INPUT_PADDED_LEN   (VAD_CONTEXT_SAMPLES + SILERO_VAD_WINDOW_SAMPLES_16K + 64)  /* = 640 */
#define VAD_STFT_BINS          129   /* (filter_length / 2) + 1 */
#define VAD_STFT_FRAMES          4   /* (640 - 256)/128 + 1 */
#define VAD_ENCODER_T            1   /* after stride 1, 2, 2, 1 over 4 STFT frames */
#define VAD_LSTM_INPUT_DIM     128
#define VAD_HIDDEN_DIM         SILERO_VAD_STATE_HIDDEN_DIM
#define VAD_CELL_DIM           SILERO_VAD_STATE_CELL_DIM

/* ── GGUF v3 minimal reader ────────────────────────────────────────── */

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
    /* Scalar values for the keys we actually consume. */
    union {
        uint32_t u32;
    } scalar;
    const char *str_val;
    uint64_t    str_len;
} vad_kv;

typedef struct {
    char       *name;
    int         ndim;
    int64_t     dims[MAX_TENSOR_DIMS];
    uint32_t    dtype;
    uint64_t    data_off;  /* absolute file offset */
    uint64_t    n_bytes;
} vad_tensor;

typedef struct {
    int    fd;
    void  *map;
    size_t map_size;

    vad_kv     *kvs;
    size_t      n_kvs;
    vad_tensor *tensors;
    size_t      n_tensors;
    uint64_t    alignment;
} vad_gguf;

static int read_u32_le(const uint8_t *p, size_t avail, size_t *cur, uint32_t *out) {
    if (*cur + 4 > avail) return -EINVAL;
    memcpy(out, p + *cur, 4);
    *cur += 4;
    return 0;
}

static int read_u64_le(const uint8_t *p, size_t avail, size_t *cur, uint64_t *out) {
    if (*cur + 8 > avail) return -EINVAL;
    memcpy(out, p + *cur, 8);
    *cur += 8;
    return 0;
}

static int read_str_le(const uint8_t *p, size_t avail, size_t *cur,
                       const char **str_out, uint64_t *len_out) {
    uint64_t len = 0;
    int rc = read_u64_le(p, avail, cur, &len);
    if (rc) return rc;
    if (*cur + len > avail) return -EINVAL;
    *str_out = (const char *)(p + *cur);
    *len_out = len;
    *cur += len;
    return 0;
}

/* Skip an unknown KV value of the given type, advancing *cur. The
 * runtime only consumes a handful of typed keys; everything else is
 * traversed but discarded. */
static int skip_kv_value(const uint8_t *p, size_t avail, size_t *cur, uint32_t type) {
    switch (type) {
        case GGUF_TYPE_UINT8:
        case GGUF_TYPE_INT8:
        case GGUF_TYPE_BOOL:
            if (*cur + 1 > avail) return -EINVAL;
            *cur += 1; return 0;
        case GGUF_TYPE_UINT16:
        case GGUF_TYPE_INT16:
            if (*cur + 2 > avail) return -EINVAL;
            *cur += 2; return 0;
        case GGUF_TYPE_UINT32:
        case GGUF_TYPE_INT32:
        case GGUF_TYPE_FLOAT32:
            if (*cur + 4 > avail) return -EINVAL;
            *cur += 4; return 0;
        case GGUF_TYPE_UINT64:
        case GGUF_TYPE_INT64:
        case GGUF_TYPE_FLOAT64:
            if (*cur + 8 > avail) return -EINVAL;
            *cur += 8; return 0;
        case GGUF_TYPE_STRING: {
            const char *s; uint64_t len;
            return read_str_le(p, avail, cur, &s, &len);
        }
        case GGUF_TYPE_ARRAY: {
            uint32_t elem_type;
            uint64_t n_elem;
            if (read_u32_le(p, avail, cur, &elem_type)) return -EINVAL;
            if (read_u64_le(p, avail, cur, &n_elem))    return -EINVAL;
            for (uint64_t i = 0; i < n_elem; ++i) {
                int rc = skip_kv_value(p, avail, cur, elem_type);
                if (rc) return rc;
            }
            return 0;
        }
        default:
            return -EINVAL;
    }
}

static void vad_gguf_close(vad_gguf *g) {
    if (g == NULL) return;
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

/* Compute the size in bytes of a tensor of `dtype` and `n_elem`
 * elements. Returns 0 (and writes 0 to *out) for unsupported dtypes
 * so the caller can produce a clear error. */
static int dtype_byte_size(uint32_t dtype, uint64_t n_elem, uint64_t *out) {
    switch (dtype) {
        case GGML_TYPE_F32: *out = n_elem * 4; return 0;
        case GGML_TYPE_F16: *out = n_elem * 2; return 0;
        default:            *out = 0;          return -EINVAL;
    }
}

static vad_gguf *vad_gguf_open(const char *path, int *err) {
    *err = 0;
    int fd = open(path, O_RDONLY);
    if (fd < 0) { *err = -errno; return NULL; }

    struct stat st;
    if (fstat(fd, &st) != 0) { *err = -errno; close(fd); return NULL; }
    if (st.st_size < 16) { *err = -EINVAL; close(fd); return NULL; }

    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map == MAP_FAILED) { *err = -errno; close(fd); return NULL; }

    vad_gguf *g = (vad_gguf *)calloc(1, sizeof(*g));
    if (g == NULL) { munmap(map, (size_t)st.st_size); close(fd); *err = -ENOMEM; return NULL; }
    g->fd       = fd;
    g->map      = map;
    g->map_size = (size_t)st.st_size;
    g->alignment = 32;

    const uint8_t *p = (const uint8_t *)map;
    size_t cur = 0;

    if (memcmp(p, GGUF_MAGIC, 4) != 0) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
    cur += 4;

    uint32_t version = 0;
    if (read_u32_le(p, g->map_size, &cur, &version)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
    if (version != 3) { *err = -EINVAL; vad_gguf_close(g); return NULL; }

    uint64_t n_tensors = 0, n_kvs = 0;
    if (read_u64_le(p, g->map_size, &cur, &n_tensors)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
    if (read_u64_le(p, g->map_size, &cur, &n_kvs))     { *err = -EINVAL; vad_gguf_close(g); return NULL; }

    g->kvs = (vad_kv *)calloc((size_t)n_kvs, sizeof(vad_kv));
    if (n_kvs > 0 && g->kvs == NULL) { *err = -ENOMEM; vad_gguf_close(g); return NULL; }
    g->n_kvs = (size_t)n_kvs;

    for (size_t i = 0; i < g->n_kvs; ++i) {
        const char *kn; uint64_t kl;
        if (read_str_le(p, g->map_size, &cur, &kn, &kl)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        g->kvs[i].name = (char *)malloc(kl + 1);
        if (g->kvs[i].name == NULL) { *err = -ENOMEM; vad_gguf_close(g); return NULL; }
        memcpy(g->kvs[i].name, kn, kl);
        g->kvs[i].name[kl] = '\0';

        uint32_t type = 0;
        if (read_u32_le(p, g->map_size, &cur, &type)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        g->kvs[i].type = type;

        if (type == GGUF_TYPE_UINT32) {
            if (read_u32_le(p, g->map_size, &cur, &g->kvs[i].scalar.u32)) {
                *err = -EINVAL; vad_gguf_close(g); return NULL;
            }
        } else if (type == GGUF_TYPE_STRING) {
            if (read_str_le(p, g->map_size, &cur,
                            &g->kvs[i].str_val, &g->kvs[i].str_len)) {
                *err = -EINVAL; vad_gguf_close(g); return NULL;
            }
        } else {
            /* All other typed values: capture is unnecessary; skip. */
            if (skip_kv_value(p, g->map_size, &cur, type)) {
                *err = -EINVAL; vad_gguf_close(g); return NULL;
            }
        }
    }

    /* Honor general.alignment when it was emitted (default 32). */
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (strcmp(g->kvs[i].name, "general.alignment") == 0
            && g->kvs[i].type == GGUF_TYPE_UINT32
            && g->kvs[i].scalar.u32 > 0) {
            g->alignment = g->kvs[i].scalar.u32;
        }
    }

    g->tensors = (vad_tensor *)calloc((size_t)n_tensors, sizeof(vad_tensor));
    if (n_tensors > 0 && g->tensors == NULL) { *err = -ENOMEM; vad_gguf_close(g); return NULL; }
    g->n_tensors = (size_t)n_tensors;

    for (size_t i = 0; i < g->n_tensors; ++i) {
        const char *tn; uint64_t tl;
        if (read_str_le(p, g->map_size, &cur, &tn, &tl)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        g->tensors[i].name = (char *)malloc(tl + 1);
        if (g->tensors[i].name == NULL) { *err = -ENOMEM; vad_gguf_close(g); return NULL; }
        memcpy(g->tensors[i].name, tn, tl);
        g->tensors[i].name[tl] = '\0';

        uint32_t ndim = 0;
        if (read_u32_le(p, g->map_size, &cur, &ndim)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        if (ndim > MAX_TENSOR_DIMS) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        g->tensors[i].ndim = (int)ndim;
        for (uint32_t d = 0; d < ndim; ++d) {
            uint64_t dim = 0;
            if (read_u64_le(p, g->map_size, &cur, &dim)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
            g->tensors[i].dims[d] = (int64_t)dim;
        }

        uint32_t dtype = 0;
        if (read_u32_le(p, g->map_size, &cur, &dtype)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        g->tensors[i].dtype = dtype;

        uint64_t off_rel = 0;
        if (read_u64_le(p, g->map_size, &cur, &off_rel)) { *err = -EINVAL; vad_gguf_close(g); return NULL; }
        g->tensors[i].data_off = off_rel;  /* relative; resolved below */

        uint64_t n_elem = 1;
        for (int d = 0; d < g->tensors[i].ndim; ++d) {
            n_elem *= (uint64_t)g->tensors[i].dims[d];
        }
        if (dtype_byte_size(dtype, n_elem, &g->tensors[i].n_bytes)) {
            *err = -EINVAL; vad_gguf_close(g); return NULL;
        }
    }

    /* Resolve absolute tensor data offsets (data section starts at the
     * next multiple of `alignment` past the metadata). */
    uint64_t data_section_off = (cur + g->alignment - 1) & ~(g->alignment - 1);
    for (size_t i = 0; i < g->n_tensors; ++i) {
        g->tensors[i].data_off += data_section_off;
        if (g->tensors[i].data_off + g->tensors[i].n_bytes > g->map_size) {
            *err = -EINVAL; vad_gguf_close(g); return NULL;
        }
    }

    return g;
}

static const char *vad_gguf_get_string(const vad_gguf *g, const char *key, uint64_t *len_out) {
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (g->kvs[i].type == GGUF_TYPE_STRING && strcmp(g->kvs[i].name, key) == 0) {
            if (len_out) *len_out = g->kvs[i].str_len;
            return g->kvs[i].str_val;
        }
    }
    return NULL;
}

static int vad_gguf_get_uint32(const vad_gguf *g, const char *key, uint32_t *out) {
    for (size_t i = 0; i < g->n_kvs; ++i) {
        if (g->kvs[i].type == GGUF_TYPE_UINT32 && strcmp(g->kvs[i].name, key) == 0) {
            *out = g->kvs[i].scalar.u32;
            return 0;
        }
    }
    return -ENOENT;
}

static const vad_tensor *vad_gguf_find(const vad_gguf *g, const char *name) {
    for (size_t i = 0; i < g->n_tensors; ++i) {
        if (strcmp(g->tensors[i].name, name) == 0) return &g->tensors[i];
    }
    return NULL;
}

/* IEEE 754 fp16 → fp32. Pure-C, no <stdfloat>; covers the full range
 * (subnormals included) the converter can emit. */
static float fp16_to_fp32(uint16_t h) {
    uint32_t s = (uint32_t)(h >> 15) & 0x1u;
    uint32_t e = (uint32_t)(h >> 10) & 0x1Fu;
    uint32_t m = (uint32_t)(h)        & 0x3FFu;
    uint32_t f;
    if (e == 0) {
        if (m == 0) {
            f = s << 31;
        } else {
            /* subnormal */
            while ((m & 0x400u) == 0) { m <<= 1; e -= 1; }
            e += 1;
            m &= ~0x400u;
            f = (s << 31) | ((e + (127 - 15)) << 23) | (m << 13);
        }
    } else if (e == 31) {
        f = (s << 31) | 0x7F800000u | (m << 13);  /* inf / NaN */
    } else {
        f = (s << 31) | ((e + (127 - 15)) << 23) | (m << 13);
    }
    float out;
    memcpy(&out, &f, 4);
    return out;
}

/* Load tensor `name`, expecting fp16, into a freshly-allocated fp32
 * buffer. Returns the buffer (caller frees) or NULL on missing/wrong-
 * shape. `dims_expected` are checked in **PyTorch / numpy order**:
 * GGUF stores dimensions with the fastest-changing axis first
 * (the gg/ml convention), so a PyTorch `(C_out, C_in, K)` tensor
 * appears in the GGUF tensor record as `[K, C_in, C_out]`. We
 * reverse the GGUF dims here to keep callers working in the natural
 * numpy order. */
static float *vad_load_fp16_to_fp32(
    const vad_gguf *g, const char *name,
    const int64_t *dims_expected, int ndim_expected,
    size_t *n_elem_out, int *err) {
    *err = 0;
    const vad_tensor *t = vad_gguf_find(g, name);
    if (t == NULL) { *err = -ENOENT; return NULL; }
    if (t->dtype != GGML_TYPE_F16) { *err = -EINVAL; return NULL; }
    if (t->ndim != ndim_expected) { *err = -EINVAL; return NULL; }
    for (int d = 0; d < ndim_expected; ++d) {
        /* GGUF dim[d] corresponds to PyTorch dim[ndim-1-d]. */
        if (t->dims[ndim_expected - 1 - d] != dims_expected[d]) {
            *err = -EINVAL; return NULL;
        }
    }
    uint64_t n_elem = 1;
    for (int d = 0; d < t->ndim; ++d) n_elem *= (uint64_t)t->dims[d];
    float *out = (float *)malloc(n_elem * sizeof(float));
    if (out == NULL) { *err = -ENOMEM; return NULL; }
    const uint8_t *base = (const uint8_t *)g->map + t->data_off;
    for (uint64_t i = 0; i < n_elem; ++i) {
        uint16_t h;
        memcpy(&h, base + i * 2, 2);
        out[i] = fp16_to_fp32(h);
    }
    if (n_elem_out) *n_elem_out = (size_t)n_elem;
    return out;
}

/* ── Session ──────────────────────────────────────────────────────── */

struct silero_vad_session {
    /* Weights (fp32, owned). */
    float *stft_basis;        /* (130, 1, 128) */
    float *enc_w[4];          /* enc.k: (cout, cin, 3) */
    float *enc_b[4];          /* enc.k: (cout) */
    int    enc_cout[4];
    int    enc_cin[4];
    int    enc_stride[4];

    float *lstm_w_ih;         /* (4*H, in) */
    float *lstm_w_hh;         /* (4*H, H)  */
    float *lstm_b_ih;         /* (4*H)     */
    float *lstm_b_hh;         /* (4*H)     */

    float *head_w;            /* (1, 128, 1) — 1×1 conv */
    float *head_b;            /* (1) */

    /* Per-session LSTM state. */
    silero_vad_state_t state;

    /* Per-session 64-sample context — the last `VAD_CONTEXT_SAMPLES`
     * of the previous window. Prepended to each new window before
     * STFT; cleared by `silero_vad_reset_state`. Mirrors the upstream
     * `OnnxWrapper._context` buffer (`silero_vad/utils_vad.py`). */
    float context[VAD_CONTEXT_SAMPLES];
};

static void session_free(struct silero_vad_session *s) {
    if (s == NULL) return;
    free(s->stft_basis);
    for (int i = 0; i < 4; ++i) {
        free(s->enc_w[i]);
        free(s->enc_b[i]);
    }
    free(s->lstm_w_ih);
    free(s->lstm_w_hh);
    free(s->lstm_b_ih);
    free(s->lstm_b_hh);
    free(s->head_w);
    free(s->head_b);
    free(s);
}

/* ── Numerical kernels (scalar) ───────────────────────────────────── */

/* Conv1D, batch-of-1, no dilation, valid+pad as PyTorch does it.
 *
 *   x:       (cin, T_in)
 *   w:       (cout, cin, k)
 *   b:       (cout) or NULL
 *   out:     (cout, T_out) where T_out = (T_in + 2*pad - k) / stride + 1
 *
 * Caller must size `out` correctly. The encoder uses k=3 pad=1 with
 * stride 1 or 2; the STFT uses k=128 pad=0 stride=64; the head uses
 * k=1 pad=0 stride=1.
 */
static void conv1d_ref(
    const float *x, int cin, int T_in,
    const float *w, int cout, int k,
    const float *b,
    int stride, int pad,
    float *out) {
    const int T_out = (T_in + 2 * pad - k) / stride + 1;
    for (int oc = 0; oc < cout; ++oc) {
        const float bias = (b != NULL) ? b[oc] : 0.0f;
        for (int t = 0; t < T_out; ++t) {
            double acc = 0.0;
            const int t0 = t * stride - pad;
            for (int ic = 0; ic < cin; ++ic) {
                const float *wkp = w + ((size_t)oc * cin + ic) * k;
                const float *xcp = x + (size_t)ic * T_in;
                for (int kk = 0; kk < k; ++kk) {
                    const int xi = t0 + kk;
                    if (xi < 0 || xi >= T_in) continue;
                    acc += (double)wkp[kk] * (double)xcp[xi];
                }
            }
            out[(size_t)oc * T_out + t] = (float)acc + bias;
        }
    }
}

static void relu_inplace(float *x, size_t n) {
    for (size_t i = 0; i < n; ++i) if (x[i] < 0.0f) x[i] = 0.0f;
}

static float sigmoidf(float x) {
    /* Numerically-stable form keeps the gate well-behaved on extreme
     * inputs that the LSTM occasionally produces during warm-up. */
    if (x >= 0.0f) {
        const float e = expf(-x);
        return 1.0f / (1.0f + e);
    } else {
        const float e = expf(x);
        return e / (1.0f + e);
    }
}

static float tanhf_(float x) {
    /* Standard library's tanhf is fine numerically; alias keeps the
     * call sites readable next to sigmoidf. */
    return tanhf(x);
}

/* PyTorch LSTM cell, gate order (i, f, g, o) inside w_ih/w_hh row blocks.
 *   x:    (input_dim)
 *   h:    (hidden_dim) — read in, written out (in place)
 *   c:    (hidden_dim) — same
 *   w_ih: (4H, input_dim)
 *   w_hh: (4H, H)
 *   b_ih: (4H)
 *   b_hh: (4H)
 *
 * Single timestep. The runtime calls this once per encoder timestep
 * (T=2 per window) and threads h/c through the per-session state.
 */
static void lstm_step_ref(
    const float *x, int input_dim,
    float *h, float *c, int H,
    const float *w_ih, const float *w_hh,
    const float *b_ih, const float *b_hh,
    float *gate_scratch /* size 4H */) {
    /* gate = w_ih @ x + b_ih + w_hh @ h + b_hh */
    for (int g = 0; g < 4 * H; ++g) {
        double acc = (double)b_ih[g] + (double)b_hh[g];
        const float *wi = w_ih + (size_t)g * input_dim;
        for (int k = 0; k < input_dim; ++k) acc += (double)wi[k] * (double)x[k];
        const float *wh = w_hh + (size_t)g * H;
        for (int k = 0; k < H; ++k) acc += (double)wh[k] * (double)h[k];
        gate_scratch[g] = (float)acc;
    }
    /* Apply gate activations and update c, h. */
    for (int j = 0; j < H; ++j) {
        const float i_g = sigmoidf(gate_scratch[0 * H + j]);
        const float f_g = sigmoidf(gate_scratch[1 * H + j]);
        const float g_g = tanhf_(gate_scratch[2 * H + j]);
        const float o_g = sigmoidf(gate_scratch[3 * H + j]);
        const float c_new = f_g * c[j] + i_g * g_g;
        c[j] = c_new;
        h[j] = o_g * tanhf_(c_new);
    }
}

/* Build the model's 640-sample input from:
 *   - `ctx`     : the last 64 samples of the previous window
 *                 (zeros at session boundaries).
 *   - `window`  : the current 512 samples.
 *   - reflect-pad-right(64) on the combined (ctx + window) buffer.
 *
 * Layout matches what upstream's `OnnxWrapper.__call__` constructs
 * via `torch.cat([context, x], dim=1)` followed by the model's
 * internal `Pad(mode="reflect", pads=[0, 64])`. The PyTorch /
 * ONNX "reflect" convention does NOT repeat the boundary sample:
 * for input `[..., a, b, c]` and right-pad 2 the appended values
 * are `[b, a]`. */
static void build_padded_input(
    const float *ctx,           /* len VAD_CONTEXT_SAMPLES (64) */
    const float *window,        /* len SILERO_VAD_WINDOW_SAMPLES_16K (512) */
    float *dst                  /* len VAD_INPUT_PADDED_LEN (640) */
) {
    /* Prepend context. */
    memcpy(dst, ctx, sizeof(float) * VAD_CONTEXT_SAMPLES);
    /* Append window. */
    memcpy(dst + VAD_CONTEXT_SAMPLES, window,
           sizeof(float) * SILERO_VAD_WINDOW_SAMPLES_16K);
    /* Right-pad with reflection of the last 64 source samples
     * (mirror without repeating the boundary). */
    const int unpadded_n = VAD_CONTEXT_SAMPLES + SILERO_VAD_WINDOW_SAMPLES_16K;
    for (int i = 0; i < 64; ++i) {
        dst[unpadded_n + i] = dst[unpadded_n - 2 - i];
    }
}

/* ── Forward pass ─────────────────────────────────────────────────── */

static int forward_window(
    struct silero_vad_session *s,
    const float *pcm,  /* 512 samples */
    float *speech_prob_out) {
    int rc = 0;

    /* 1. Build the 640-sample STFT input: context (64) + window (512) +
     *    reflect-right (64). The context carries the last 64 samples
     *    of the previous call (or zeros on a fresh session / post-reset). */
    const int padded_n = VAD_INPUT_PADDED_LEN;
    float *padded = (float *)malloc(sizeof(float) * (size_t)padded_n);
    if (padded == NULL) { rc = -ENOMEM; goto done; }
    build_padded_input(s->context, pcm, padded);
    /* Promote: this call's last 64 samples become next call's context. */
    memcpy(s->context,
           pcm + SILERO_VAD_WINDOW_SAMPLES_16K - VAD_CONTEXT_SAMPLES,
           sizeof(float) * VAD_CONTEXT_SAMPLES);

    /* 2. STFT Conv: 1→258, k=256, stride=128. Input shape (1, 640).
     *    Output shape (258, 4). */
    const int stft_C_out = 2 * VAD_STFT_BINS;  /* 258 = 129 real + 129 imag */
    const int stft_T_out = VAD_STFT_FRAMES;    /* 4 */
    float *stft = (float *)malloc(sizeof(float) * (size_t)stft_C_out * (size_t)stft_T_out);
    if (stft == NULL) { rc = -ENOMEM; goto done; }
    conv1d_ref(padded, /*cin*/ 1, padded_n,
               s->stft_basis, /*cout*/ stft_C_out, /*k*/ VAD_STFT_FILTER_LENGTH,
               /*b*/ NULL,
               /*stride*/ VAD_STFT_HOP, /*pad*/ 0,
               stft);

    /* 3. Magnitude: (129, 4) = sqrt((real[0..129])^2 + (imag[129..258])^2). */
    float *mag = (float *)malloc(sizeof(float) * VAD_STFT_BINS * (size_t)stft_T_out);
    if (mag == NULL) { rc = -ENOMEM; goto done; }
    for (int b = 0; b < VAD_STFT_BINS; ++b) {
        for (int t = 0; t < stft_T_out; ++t) {
            const float re = stft[(size_t)b * stft_T_out + t];
            const float im = stft[(size_t)(b + VAD_STFT_BINS) * stft_T_out + t];
            mag[(size_t)b * stft_T_out + t] = sqrtf(re * re + im * im);
        }
    }
    free(stft); stft = NULL;

    /* 4. Encoder: 4 conv layers + ReLU each. */
    float *cur = mag; mag = NULL;
    int cur_C = VAD_STFT_BINS;
    int cur_T = stft_T_out;
    for (int i = 0; i < 4; ++i) {
        const int oc = s->enc_cout[i];
        const int next_T = (cur_T + 2 - 3) / s->enc_stride[i] + 1; /* k=3 pad=1 */
        float *out = (float *)malloc(sizeof(float) * (size_t)oc * (size_t)next_T);
        if (out == NULL) { rc = -ENOMEM; free(cur); goto done; }
        conv1d_ref(cur, cur_C, cur_T,
                   s->enc_w[i], oc, /*k*/ 3,
                   s->enc_b[i],
                   s->enc_stride[i], /*pad*/ 1,
                   out);
        relu_inplace(out, (size_t)oc * (size_t)next_T);
        free(cur);
        cur = out;
        cur_C = oc;
        cur_T = next_T;
    }
    /* Sanity: encoder output must be (128, 2). */
    if (cur_C != VAD_LSTM_INPUT_DIM || cur_T != VAD_ENCODER_T) {
        free(cur);
        rc = -EINVAL;
        goto done;
    }

    /* 5. LSTM: 2 timesteps, hidden_dim=128. PyTorch convention:
     *    h_t, c_t = LSTM(x_t, (h_{t-1}, c_{t-1}))
     *    The encoder activation is laid out as (C=128, T=2). The
     *    LSTM expects per-timestep input (input_dim=128) — slice along
     *    the T axis.
     */
    float gate_scratch[4 * VAD_HIDDEN_DIM];
    float x_t[VAD_LSTM_INPUT_DIM];

    /* Promote: prev window's *_out becomes this window's *_in. The
     * caller (`silero_vad_process`) owns calling reset between
     * utterances. We do the in-place copy here so a sequence of
     * `silero_vad_process` calls advances state correctly. */
    silero_vad_state_promote(&s->state);

    for (int t = 0; t < cur_T; ++t) {
        for (int c = 0; c < VAD_LSTM_INPUT_DIM; ++c) {
            x_t[c] = cur[(size_t)c * cur_T + t];
        }
        lstm_step_ref(x_t, VAD_LSTM_INPUT_DIM,
                      s->state.h_in, s->state.c_in, VAD_HIDDEN_DIM,
                      s->lstm_w_ih, s->lstm_w_hh,
                      s->lstm_b_ih, s->lstm_b_hh,
                      gate_scratch);
    }
    /* Capture the final h/c into *_out so the next promote() picks them up. */
    memcpy(s->state.h_out, s->state.h_in, sizeof(s->state.h_out));
    memcpy(s->state.c_out, s->state.c_in, sizeof(s->state.c_out));
    free(cur);

    /* 6. Output head: ReLU(h_last) → 1×1 Conv (128 → 1) + bias → sigmoid. */
    float relu_h[VAD_HIDDEN_DIM];
    for (int j = 0; j < VAD_HIDDEN_DIM; ++j) {
        relu_h[j] = s->state.h_out[j] > 0.0f ? s->state.h_out[j] : 0.0f;
    }
    /* Conv 128→1 with kernel=1: y = sum_j w[j] * relu_h[j] + bias. */
    double acc = (double)s->head_b[0];
    for (int j = 0; j < VAD_HIDDEN_DIM; ++j) {
        acc += (double)s->head_w[j] * (double)relu_h[j];
    }
    *speech_prob_out = sigmoidf((float)acc);

done:
    free(padded);
    free(mag);
    return rc;
}

/* ── Public ABI ───────────────────────────────────────────────────── */

int silero_vad_open(const char *gguf_path, silero_vad_handle *out) {
    if (out != NULL) *out = NULL;
    if (gguf_path == NULL || out == NULL) return -EINVAL;

    int err = 0;
    vad_gguf *g = vad_gguf_open(gguf_path, &err);
    if (g == NULL) {
        return err == 0 ? -ENOENT : err;
    }

    /* Refuse anything that isn't the variant we know how to run. */
    uint64_t variant_len = 0;
    const char *variant = vad_gguf_get_string(g, "silero_vad.variant", &variant_len);
    if (variant == NULL
        || variant_len != strlen(SILERO_VAD_VARIANT_V5)
        || memcmp(variant, SILERO_VAD_VARIANT_V5, variant_len) != 0) {
        vad_gguf_close(g);
        return -EINVAL;
    }

    uint32_t window_samples = 0;
    if (vad_gguf_get_uint32(g, "silero_vad.window_samples", &window_samples) != 0
        || window_samples != SILERO_VAD_WINDOW_SAMPLES_16K) {
        vad_gguf_close(g);
        return -EINVAL;
    }
    uint32_t sample_rate = 0;
    if (vad_gguf_get_uint32(g, "silero_vad.sample_rate_hz", &sample_rate) != 0
        || sample_rate != SILERO_VAD_SAMPLE_RATE_HZ) {
        vad_gguf_close(g);
        return -EINVAL;
    }
    uint32_t hidden_dim = 0;
    if (vad_gguf_get_uint32(g, "silero_vad.state_hidden_dim", &hidden_dim) != 0
        || hidden_dim != VAD_HIDDEN_DIM) {
        vad_gguf_close(g);
        return -EINVAL;
    }

    struct silero_vad_session *s = (struct silero_vad_session *)calloc(1, sizeof(*s));
    if (s == NULL) { vad_gguf_close(g); return -ENOMEM; }

    /* STFT basis: (258, 1, 256) */
    {
        const int64_t shape[3] = { 2 * VAD_STFT_BINS, 1, VAD_STFT_FILTER_LENGTH };
        s->stft_basis = vad_load_fp16_to_fp32(g, "vad.stft.basis", shape, 3, NULL, &err);
        if (s->stft_basis == NULL) { session_free(s); vad_gguf_close(g); return err; }
    }

    /* Encoder weights — strides (1, 2, 2, 1) per the v5 architecture. */
    static const struct {
        const char *w; const char *b;
        int cout; int cin; int stride;
    } enc_specs[4] = {
        { "vad.encoder.0.weight", "vad.encoder.0.bias", 128, 129, 1 },
        { "vad.encoder.1.weight", "vad.encoder.1.bias",  64, 128, 2 },
        { "vad.encoder.2.weight", "vad.encoder.2.bias",  64,  64, 2 },
        { "vad.encoder.3.weight", "vad.encoder.3.bias", 128,  64, 1 },
    };
    for (int i = 0; i < 4; ++i) {
        const int64_t wshape[3] = { enc_specs[i].cout, enc_specs[i].cin, 3 };
        s->enc_w[i] = vad_load_fp16_to_fp32(g, enc_specs[i].w, wshape, 3, NULL, &err);
        if (s->enc_w[i] == NULL) { session_free(s); vad_gguf_close(g); return err; }
        const int64_t bshape[1] = { enc_specs[i].cout };
        s->enc_b[i] = vad_load_fp16_to_fp32(g, enc_specs[i].b, bshape, 1, NULL, &err);
        if (s->enc_b[i] == NULL) { session_free(s); vad_gguf_close(g); return err; }
        s->enc_cout[i] = enc_specs[i].cout;
        s->enc_cin[i]  = enc_specs[i].cin;
        s->enc_stride[i] = enc_specs[i].stride;
    }

    /* LSTM */
    {
        const int64_t wih[2] = { 4 * VAD_HIDDEN_DIM, VAD_LSTM_INPUT_DIM };
        s->lstm_w_ih = vad_load_fp16_to_fp32(g, "vad.lstm.weight_ih", wih, 2, NULL, &err);
        if (s->lstm_w_ih == NULL) { session_free(s); vad_gguf_close(g); return err; }

        const int64_t whh[2] = { 4 * VAD_HIDDEN_DIM, VAD_HIDDEN_DIM };
        s->lstm_w_hh = vad_load_fp16_to_fp32(g, "vad.lstm.weight_hh", whh, 2, NULL, &err);
        if (s->lstm_w_hh == NULL) { session_free(s); vad_gguf_close(g); return err; }

        const int64_t bih[1] = { 4 * VAD_HIDDEN_DIM };
        s->lstm_b_ih = vad_load_fp16_to_fp32(g, "vad.lstm.bias_ih", bih, 1, NULL, &err);
        if (s->lstm_b_ih == NULL) { session_free(s); vad_gguf_close(g); return err; }

        const int64_t bhh[1] = { 4 * VAD_HIDDEN_DIM };
        s->lstm_b_hh = vad_load_fp16_to_fp32(g, "vad.lstm.bias_hh", bhh, 1, NULL, &err);
        if (s->lstm_b_hh == NULL) { session_free(s); vad_gguf_close(g); return err; }
    }

    /* Head (1×1 conv 128→1) */
    {
        const int64_t wshape[3] = { 1, VAD_HIDDEN_DIM, 1 };
        s->head_w = vad_load_fp16_to_fp32(g, "vad.head.weight", wshape, 3, NULL, &err);
        if (s->head_w == NULL) { session_free(s); vad_gguf_close(g); return err; }
        const int64_t bshape[1] = { 1 };
        s->head_b = vad_load_fp16_to_fp32(g, "vad.head.bias", bshape, 1, NULL, &err);
        if (s->head_b == NULL) { session_free(s); vad_gguf_close(g); return err; }
    }

    silero_vad_state_reset(&s->state);
    memset(s->context, 0, sizeof(s->context));

    vad_gguf_close(g);  /* weights are copied out as fp32; we no longer need the mmap. */

    *out = (silero_vad_handle)s;
    return 0;
}

int silero_vad_reset_state(silero_vad_handle h) {
    if (h == NULL) return -EINVAL;
    silero_vad_state_reset(&h->state);
    memset(h->context, 0, sizeof(h->context));
    return 0;
}

int silero_vad_process(silero_vad_handle h,
                       const float *pcm_16khz,
                       size_t n_samples,
                       float *speech_prob_out) {
    if (speech_prob_out != NULL) *speech_prob_out = 0.0f;
    if (h == NULL || pcm_16khz == NULL || speech_prob_out == NULL) return -EINVAL;
    if (n_samples != SILERO_VAD_WINDOW_SAMPLES_16K) return -EINVAL;
    return forward_window(h, pcm_16khz, speech_prob_out);
}

int silero_vad_close(silero_vad_handle h) {
    if (h == NULL) return 0;
    session_free(h);
    return 0;
}

const char *silero_vad_active_backend(void) {
    /* Honest about what this build is: pure-C scalar, no SIMD, no ggml
     * link. A future pass can swap in an AVX2/NEON dispatcher (or the
     * ggml CPU backend) and report the change here without touching
     * the rest of the ABI. */
    return "native-cpu";
}
