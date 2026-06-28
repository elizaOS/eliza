/*
 * agent_loop.c — branch-behaviour proxy for the Eliza E1 duty cycle.
 *
 * The E1 spends its time in a looping multimodal agent built on llama.cpp:
 * tokenize text, run the transformer (dominated by quantized integer GEMV),
 * sample the next token, and parse/emit a streamed structured response. This
 * program reproduces the *branch behaviour* of that loop — not the numerics —
 * so a QEMU-RV64 execlog trace of it stresses the BPU the way the real
 * workload does. Each kernel maps to one branch class the predictor must get
 * right:
 *
 *   tokenize   — UTF-8 decode + greedy longest-match merges over a vocab:
 *                data-dependent conditional branches ("string managing").
 *   gemv_q8    — int8xint8 block dot products: long, highly-predictable loop
 *                branches that dominate the dynamic instruction count.
 *   sample     — temperature + softmax + top-k selection + argmax: medium-hard
 *                loop and comparison branches ("looping").
 *   stream     — switch-based JSON/SSE state machine over emitted bytes:
 *                indirect/irregular dispatch ("stream managing").
 *
 * All data is generated from a deterministic LCG so the trace is reproducible.
 * Sizes are tuned for a few-million-instruction trace: long enough for the
 * predictor to converge, short enough to decode quickly.
 *
 * Build (RV64, matches the E1 target ISA):
 *   riscv64-linux-gnu-gcc -O2 -static agent_loop.c -o agent_loop
 * Trace:
 *   qemu-riscv64 -plugin libexeclog.so -d plugin -D execlog.txt agent_loop
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* ---- deterministic PRNG (no libc rand, so the trace is stable) ---- */
static uint64_t g_rng = 0x9E3779B97F4A7C15ull;
static inline uint32_t lcg(void) {
    g_rng = g_rng * 6364136223846793005ull + 1442695040888963407ull;
    return (uint32_t)(g_rng >> 32);
}

/* ---- 1. tokenizer: UTF-8 decode + greedy longest-match merges ---- */
#define VOCAB 64
static uint32_t vocab_key[VOCAB];
static int vocab_len[VOCAB];

static void vocab_init(void) {
    for (int i = 0; i < VOCAB; i++) {
        vocab_key[i] = lcg();
        vocab_len[i] = 1 + (int)(lcg() % 4); /* 1..4 byte merges */
    }
}

static int tokenize(const uint8_t *buf, int n, int *out_tokens) {
    int ntok = 0, i = 0;
    while (i < n) {
        /* UTF-8 length classification: data-dependent branch on byte range. */
        uint8_t c = buf[i];
        int clen;
        if (c < 0x80) clen = 1;
        else if ((c & 0xE0) == 0xC0) clen = 2;
        else if ((c & 0xF0) == 0xE0) clen = 3;
        else if ((c & 0xF8) == 0xF0) clen = 4;
        else clen = 1; /* invalid lead byte */
        if (i + clen > n) clen = 1;

        /* Greedy longest-match: scan vocab for the longest merge that fits. */
        uint32_t window = 0;
        for (int k = 0; k < clen && i + k < n; k++)
            window = (window << 8) | buf[i + k];
        int best = -1, best_len = 0;
        for (int v = 0; v < VOCAB; v++) {
            if (vocab_len[v] <= (n - i) && vocab_len[v] > best_len) {
                /* cheap hash compare standing in for a trie/hashmap probe */
                if ((vocab_key[v] & 0xFFFF) == (window & 0xFFFF)) {
                    best = v;
                    best_len = vocab_len[v];
                }
            }
        }
        if (best >= 0) {
            out_tokens[ntok++] = best;
            i += best_len;
        } else {
            out_tokens[ntok++] = c;
            i += clen;
        }
        if (ntok >= n) break;
    }
    return ntok;
}

/* ---- 2. quantized GEMV: int8 x int8 block dot products (Q8_0-ish) ---- */
#define QK 32
static int32_t gemv_q8(const int8_t *w, const int8_t *x, int rows, int cols,
                       int32_t *out) {
    int32_t checksum = 0;
    for (int r = 0; r < rows; r++) {
        int32_t acc = 0;
        const int8_t *wr = w + (long)r * cols;
        for (int c = 0; c < cols; c += QK) {
            int32_t block = 0;
            for (int k = 0; k < QK; k++)
                block += (int32_t)wr[c + k] * (int32_t)x[c + k];
            /* per-block requant clamp: a real branch in the hot path */
            if (block > 127) block = 127;
            else if (block < -128) block = -128;
            acc += block;
        }
        out[r] = acc;
        checksum ^= acc;
    }
    return checksum;
}

/* ---- 3. sampler: temperature + softmax + top-k selection + argmax ---- */
#define TOPK 16
static int sample_token(const int32_t *logits, int n) {
    /* find max for numerical stability (comparison-branch loop) */
    int32_t mx = logits[0];
    for (int i = 1; i < n; i++)
        if (logits[i] > mx) mx = logits[i];

    /* fixed-point "softmax": exp approx via shift; accumulate */
    uint64_t sum = 0;
    static uint32_t prob[512];
    for (int i = 0; i < n; i++) {
        int32_t d = logits[i] - mx;       /* <= 0 */
        uint32_t e = (d < -40) ? 0u : (uint32_t)(1u << (uint32_t)((d + 40) >> 1));
        prob[i] = e;
        sum += e;
    }

    /* top-k selection sort: branchy partial sort over the candidate set */
    int idx[512];
    for (int i = 0; i < n; i++) idx[i] = i;
    int k = (n < TOPK) ? n : TOPK;
    for (int a = 0; a < k; a++) {
        int best = a;
        for (int b = a + 1; b < n; b++)
            if (prob[idx[b]] > prob[idx[best]]) best = b;
        int t = idx[a]; idx[a] = idx[best]; idx[best] = t;
    }

    /* sample within the top-k by the running weight (data-dependent exit) */
    uint64_t r = (uint64_t)lcg() % (sum ? sum : 1);
    uint64_t run = 0;
    for (int a = 0; a < k; a++) {
        run += prob[idx[a]];
        if (run >= r) return idx[a];
    }
    return idx[0];
}

/* ---- small libc-free helpers ---- */
static int atoi_simple(const char *s) {
    int v = 0;
    while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    return v;
}

/* Emit a streamed JSON chunk like {"i":<step>,"tok":<id>,"fin":false}. */
static int format_chunk(uint8_t *dst, int cap, int step, int tok) {
    static const char *tmpl = "{\"i\":";
    int p = 0;
    for (const char *s = tmpl; *s && p < cap; s++) dst[p++] = (uint8_t)*s;
    char num[16];
    int nn = 0, v = step;
    if (v == 0) num[nn++] = '0';
    while (v > 0 && nn < 15) { num[nn++] = (char)('0' + v % 10); v /= 10; }
    for (int j = nn - 1; j >= 0 && p < cap; j--) dst[p++] = (uint8_t)num[j];
    const char *mid = ",\"tok\":";
    for (const char *s = mid; *s && p < cap; s++) dst[p++] = (uint8_t)*s;
    nn = 0; v = tok < 0 ? 0 : tok;
    if (v == 0) num[nn++] = '0';
    while (v > 0 && nn < 15) { num[nn++] = (char)('0' + v % 10); v /= 10; }
    for (int j = nn - 1; j >= 0 && p < cap; j--) dst[p++] = (uint8_t)num[j];
    const char *tail = ",\"fin\":false}";
    for (const char *s = tail; *s && p < cap; s++) dst[p++] = (uint8_t)*s;
    return p;
}

/* ---- 4. stream parser: switch-based JSON/SSE state machine ---- */
enum { S_KEY, S_COLON, S_VAL, S_STR, S_NUM, S_DONE };
static int stream_parse(const uint8_t *buf, int n) {
    int state = S_KEY, fields = 0, depth = 0;
    for (int i = 0; i < n; i++) {
        uint8_t c = buf[i];
        switch (state) {        /* compiles to a jump table → indirect dispatch */
        case S_KEY:
            if (c == '"') state = S_STR;
            else if (c == '{') depth++;
            else if (c == '}') { if (--depth <= 0) state = S_DONE; }
            break;
        case S_STR:
            if (c == '"') state = S_COLON;
            break;
        case S_COLON:
            if (c == ':') state = S_VAL;
            else if (c == ',') state = S_KEY;
            break;
        case S_VAL:
            if (c >= '0' && c <= '9') state = S_NUM;
            else if (c == '"') state = S_STR;
            else if (c == ',') { fields++; state = S_KEY; }
            else if (c == '}') { fields++; if (--depth <= 0) state = S_DONE; }
            break;
        case S_NUM:
            if (c == ',') { fields++; state = S_KEY; }
            else if (c == '}') { fields++; if (--depth <= 0) state = S_DONE; }
            else if (!(c >= '0' && c <= '9')) state = S_VAL;
            break;
        case S_DONE:
            return fields;
        }
    }
    return fields;
}

int main(int argc, char **argv) {
    int tokens_to_generate = (argc > 1) ? atoi_simple(argv[1]) : 96;
    /* mode 0 = balanced duty cycle (GEMV-dominated, realistic, easy);
     * mode 1 = decode-heavy (tokenizer/sampler/stream, minimal GEMV) to
     *          isolate the hard data-dependent branches for predictor tuning. */
    int mode = (argc > 2) ? atoi_simple(argv[2]) : 0;

    vocab_init();

    /* model dimensions: small but representative of the GEMV branch shape */
    const int rows = 128, cols = 128, vocab_out = 128;
    static int8_t W[128 * 128];
    static int8_t emb[128];
    static int32_t hidden[128];
    static int32_t logits[128];
    for (int i = 0; i < rows * cols; i++) W[i] = (int8_t)(lcg() & 0xFF);

    /* a "prompt" text buffer to tokenize, and a streamed-output buffer */
    static uint8_t prompt[4096];
    for (int i = 0; i < (int)sizeof(prompt); i++) {
        uint32_t r = lcg();
        prompt[i] = (r & 7) ? (uint8_t)(0x20 + (r % 0x5F)) : (uint8_t)(0xC0 + (r & 0x1F));
    }
    static int tok_buf[4096];

    int total_fields = 0;
    int32_t guard = 0;

    /* ---- the agent token loop ---- */
    for (int step = 0; step < tokens_to_generate; step++) {
        /* tokenize the (rolling) prompt prefix — string-heavy branches */
        int prefix = 192 + (step * 13) % 320;
        int ntok = tokenize(prompt, prefix, tok_buf);

        /* build an embedding from the last token (cheap, data-dependent) */
        int last = (ntok ? tok_buf[ntok - 1] : 0) % rows;
        for (int i = 0; i < cols; i++)
            emb[i] = (int8_t)((W[last * cols + i]) ^ (i & 1));

        /* transformer-ish projection: the dominant predictable loop work.
         * Skipped in decode-heavy mode so the trace is not diluted by the
         * trivially-predictable GEMV loop branches. */
        if (mode != 1)
            guard ^= gemv_q8(W, emb, rows, cols, hidden);
        for (int i = 0; i < vocab_out; i++)
            logits[i] = (mode == 1 ? (int32_t)lcg() : hidden[i])
                        + (int32_t)(tok_buf[i % ntok] & 0x3F);

        /* sample next token */
        int next = sample_token(logits, vocab_out);

        /* emit a streamed JSON chunk and parse it (stream state machine) */
        static uint8_t chunk[128];
        int m = format_chunk(chunk, sizeof(chunk), step, next);
        total_fields += stream_parse(chunk, m);

        /* decode-heavy mode does extra branchy passes per token to weight
         * the trace toward the hard, data-dependent control flow. */
        if (mode == 1) {
            for (int rep = 0; rep < 6; rep++) {
                int p2 = 128 + (int)(lcg() % 320);
                int n2 = tokenize(prompt, p2, tok_buf);
                for (int i = 0; i < vocab_out; i++)
                    logits[i] = (int32_t)lcg() + (n2 ? tok_buf[i % n2] : 0);
                next = sample_token(logits, vocab_out);
                int m2 = format_chunk(chunk, sizeof(chunk), step * 6 + rep, next);
                total_fields += stream_parse(chunk, m2);
            }
        }

        /* feed the sampled token back into the prompt (autoregressive) */
        prompt[step % sizeof(prompt)] = (uint8_t)(0x20 + (next & 0x5F));
    }

    printf("guard=%d fields=%d\n", (int)guard, total_fields);
    return 0;
}
