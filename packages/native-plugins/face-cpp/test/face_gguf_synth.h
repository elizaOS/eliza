/*
 * Test-only helper: synthesize a tiny BlazeFace / face-embed GGUF on
 * disk so the runtime tests can drive face_detect_open / face_embed_open
 * without depending on the converter scripts (which require the real
 * upstream PyTorch checkpoints).
 *
 * The synthesized weights are deterministic but have no meaning —
 * they're enough to exercise the loader, the forward graph, the anchor
 * decoder, NMS, alignment, and L2-normalization. The parity test
 * (test/face_parity_test.py) validates against real reference weights.
 */

#ifndef FACE_GGUF_SYNTH_H
#define FACE_GGUF_SYNTH_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* GGUF v3 type tags (subset, matches face_gguf.c). */
enum {
    SYNTH_TYPE_UINT32 = 4,
    SYNTH_TYPE_STRING = 8,
};
enum {
    SYNTH_DTYPE_F32 = 0,
    SYNTH_DTYPE_F16 = 1,
};

/* Dynamic byte buffer. */
typedef struct {
    uint8_t *data;
    size_t   len;
    size_t   cap;
} buf_t;

static int buf_append(buf_t *b, const void *p, size_t n) {
    if (b->len + n > b->cap) {
        size_t nc = b->cap ? b->cap : 1024;
        while (nc < b->len + n) nc *= 2;
        uint8_t *nd = (uint8_t *)realloc(b->data, nc);
        if (!nd) return -1;
        b->data = nd; b->cap = nc;
    }
    memcpy(b->data + b->len, p, n);
    b->len += n;
    return 0;
}
static int buf_u32(buf_t *b, uint32_t v) { return buf_append(b, &v, 4); }
static int buf_u64(buf_t *b, uint64_t v) { return buf_append(b, &v, 8); }
static int buf_str(buf_t *b, const char *s) {
    uint64_t n = (uint64_t)strlen(s);
    if (buf_u64(b, n)) return -1;
    return buf_append(b, s, (size_t)n);
}

/* Tensor record collected during build. */
typedef struct {
    char       name[160];
    int        ndim;
    uint64_t   dims[4];
    uint32_t   dtype;     /* SYNTH_DTYPE_* */
    const float *data;    /* fp32 source — converted to fp16 if dtype=F16 */
    uint64_t   data_off;  /* set during emission */
    uint64_t   n_bytes;
} synth_tensor;

typedef struct {
    /* metadata KVs */
    struct {
        char     key[96];
        uint32_t type;
        uint32_t u32;
        char     str[96];
    } kvs[16];
    int n_kvs;
    /* tensors */
    synth_tensor tensors[256];
    int n_tensors;
} synth_gguf;

static void synth_add_kv_u32(synth_gguf *g, const char *key, uint32_t v) {
    int i = g->n_kvs++;
    snprintf(g->kvs[i].key, sizeof g->kvs[i].key, "%s", key);
    g->kvs[i].type = SYNTH_TYPE_UINT32;
    g->kvs[i].u32 = v;
}
static void synth_add_kv_str(synth_gguf *g, const char *key, const char *v) {
    int i = g->n_kvs++;
    snprintf(g->kvs[i].key, sizeof g->kvs[i].key, "%s", key);
    g->kvs[i].type = SYNTH_TYPE_STRING;
    snprintf(g->kvs[i].str, sizeof g->kvs[i].str, "%s", v);
}

static void synth_add_tensor_f32(synth_gguf *g, const char *name,
                                 const float *data, int ndim, ...)
{
    int i = g->n_tensors++;
    snprintf(g->tensors[i].name, sizeof g->tensors[i].name, "%s", name);
    g->tensors[i].ndim = ndim;
    g->tensors[i].dtype = SYNTH_DTYPE_F32;
    g->tensors[i].data = data;
    /* dims passed via va_args: ndim ints */
    va_list ap;
    va_start(ap, ndim);
    uint64_t elems = 1;
    for (int d = 0; d < ndim; ++d) {
        int dim = va_arg(ap, int);
        g->tensors[i].dims[d] = (uint64_t)dim;
        elems *= (uint64_t)dim;
    }
    va_end(ap);
    g->tensors[i].n_bytes = elems * 4;
}

/* Convert fp32 to fp16 (round-to-nearest-even, no special handling for
 * NaN/inf — the synth uses only finite small values). */
static uint16_t f32_to_f16(float f) {
    uint32_t bits;
    memcpy(&bits, &f, 4);
    uint32_t sign = (bits >> 31) & 0x1u;
    int32_t  exp  = ((bits >> 23) & 0xFFu) - 127 + 15;
    uint32_t mant = bits & 0x7FFFFFu;
    if (exp <= 0) return (uint16_t)(sign << 15);
    if (exp >= 31) return (uint16_t)((sign << 15) | (0x1F << 10));
    /* round mantissa: take top 10 bits, round half-to-even */
    uint32_t round = (mant + 0x1000u) >> 13;
    if (round > 0x3FFu) {
        round = 0;
        ++exp;
        if (exp >= 31) return (uint16_t)((sign << 15) | (0x1F << 10));
    }
    return (uint16_t)((sign << 15) | ((uint32_t)exp << 10) | round);
}

/* Emit the GGUF to a buffer, then write the buffer to disk. */
static int synth_write(synth_gguf *g, const char *path) {
    buf_t hdr = {0};
    /* header */
    if (buf_append(&hdr, "GGUF", 4)) goto oom;
    if (buf_u32(&hdr, 3)) goto oom;
    if (buf_u64(&hdr, (uint64_t)g->n_tensors)) goto oom;
    if (buf_u64(&hdr, (uint64_t)g->n_kvs)) goto oom;

    /* KVs */
    for (int i = 0; i < g->n_kvs; ++i) {
        if (buf_str(&hdr, g->kvs[i].key)) goto oom;
        if (buf_u32(&hdr, g->kvs[i].type)) goto oom;
        if (g->kvs[i].type == SYNTH_TYPE_UINT32) {
            if (buf_u32(&hdr, g->kvs[i].u32)) goto oom;
        } else if (g->kvs[i].type == SYNTH_TYPE_STRING) {
            if (buf_str(&hdr, g->kvs[i].str)) goto oom;
        }
    }

    /* Tensor info (assign offsets after we know the total info size) */
    /* First pass: write tensor info with placeholder offsets to compute
     * size, then re-write with correct offsets. Simpler: compute sizes
     * before we emit. */
    uint64_t cumulative_off = 0;
    const uint64_t alignment = 32;
    for (int i = 0; i < g->n_tensors; ++i) {
        if (g->tensors[i].dtype == SYNTH_DTYPE_F32) {
            uint64_t elems = 1;
            for (int d = 0; d < g->tensors[i].ndim; ++d) elems *= g->tensors[i].dims[d];
            g->tensors[i].n_bytes = elems * 4;
        } else {
            uint64_t elems = 1;
            for (int d = 0; d < g->tensors[i].ndim; ++d) elems *= g->tensors[i].dims[d];
            g->tensors[i].n_bytes = elems * 2;
        }
        g->tensors[i].data_off = cumulative_off;
        /* pad next to alignment */
        cumulative_off += g->tensors[i].n_bytes;
        uint64_t pad = (alignment - (cumulative_off % alignment)) % alignment;
        cumulative_off += pad;
    }

    for (int i = 0; i < g->n_tensors; ++i) {
        if (buf_str(&hdr, g->tensors[i].name)) goto oom;
        if (buf_u32(&hdr, (uint32_t)g->tensors[i].ndim)) goto oom;
        /* Match GGUFWriter: store dimensions fastest-varying first
         * (reverse of PyTorch's (cout, cin, kh, kw) convention). The
         * face_gguf_open reader un-reverses on load. */
        for (int d = 0; d < g->tensors[i].ndim; ++d) {
            const int j = g->tensors[i].ndim - 1 - d;
            if (buf_u64(&hdr, g->tensors[i].dims[j])) goto oom;
        }
        if (buf_u32(&hdr, g->tensors[i].dtype)) goto oom;
        if (buf_u64(&hdr, g->tensors[i].data_off)) goto oom;
    }

    /* Pad header to alignment for the data section. */
    uint64_t pad = (alignment - (hdr.len % alignment)) % alignment;
    static const uint8_t zeros[64] = {0};
    if (pad) {
        if (buf_append(&hdr, zeros, (size_t)pad)) goto oom;
    }

    /* Now write tensor bytes. */
    FILE *fp = fopen(path, "wb");
    if (!fp) goto oom;
    if (fwrite(hdr.data, 1, hdr.len, fp) != hdr.len) { fclose(fp); goto oom; }
    free(hdr.data); hdr.data = NULL;

    for (int i = 0; i < g->n_tensors; ++i) {
        uint64_t elems = 1;
        for (int d = 0; d < g->tensors[i].ndim; ++d) elems *= g->tensors[i].dims[d];
        if (g->tensors[i].dtype == SYNTH_DTYPE_F32) {
            if (fwrite(g->tensors[i].data, 4, (size_t)elems, fp) != (size_t)elems) {
                fclose(fp); return -1;
            }
        } else {
            for (uint64_t k = 0; k < elems; ++k) {
                uint16_t h = f32_to_f16(g->tensors[i].data[k]);
                if (fwrite(&h, 2, 1, fp) != 1) { fclose(fp); return -1; }
            }
        }
        /* pad */
        uint64_t got = g->tensors[i].n_bytes;
        uint64_t p   = (alignment - (got % alignment)) % alignment;
        if (p) {
            if (fwrite(zeros, 1, (size_t)p, fp) != (size_t)p) { fclose(fp); return -1; }
        }
    }
    fclose(fp);
    return 0;

oom:
    free(hdr.data);
    return -1;
}

#endif /* FACE_GGUF_SYNTH_H */
