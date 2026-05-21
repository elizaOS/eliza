/*
 * io_stream.c — branch-behaviour proxies for the E1's streaming/IO duty cycle.
 *
 * The agent does more than run llama.cpp: it parses HTTP, splits text/logs,
 * walks binary file containers, and decodes streamed audio/video. Those paths
 * are dominated by *irregular, data-dependent* control flow (parsers, state
 * machines, variable-length symbol decode, indirect dispatch) — exactly the
 * branches a predictor must work hardest on, and where there is real MPKI
 * headroom versus the loop-dominated inference path.
 *
 * One mode per domain, selected by argv[2]; argv[1] scales the workload:
 *   0 http   — HTTP/1.1 request parse + method/path router (indirect dispatch)
 *   1 text   — log/CSV line scanner: field split, int/float parse, matching
 *   2 fileio — TLV binary container walk: magic/len checks, type switch, CRC
 *   3 video  — block decode: zigzag + RLE/VLC symbol decode + clamp (codec)
 *   4 audio  — frame decode: subband filter + quantizer decision + gain ramp
 *
 * Build (RV64): riscv64-linux-gnu-gcc -O2 -static io_stream.c -o io_stream
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint64_t g_rng = 0xDEADBEEFCAFEBABEull;
static inline uint32_t lcg(void) {
    g_rng = g_rng * 6364136223846793005ull + 1442695040888963407ull;
    return (uint32_t)(g_rng >> 32);
}

static int atoi_simple(const char *s) {
    int v = 0;
    while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    return v;
}

/* ===================== 0. HTTP/1.1 request parser + router ============== */
enum { M_GET, M_POST, M_PUT, M_DELETE, M_HEAD, M_OTHER };

static int http_method(const uint8_t *b, int n) {
    if (n >= 3 && b[0] == 'G' && b[1] == 'E' && b[2] == 'T') return M_GET;
    if (n >= 4 && b[0] == 'P' && b[1] == 'O') return M_POST;
    if (n >= 3 && b[0] == 'P' && b[1] == 'U') return M_PUT;
    if (n >= 6 && b[0] == 'D') return M_DELETE;
    if (n >= 4 && b[0] == 'H') return M_HEAD;
    return M_OTHER;
}

/* route handlers: distinct functions reached via a function-pointer table so
 * the dispatch is a real indirect branch (ITTAGE/BTB territory). */
static int h_root(int x) { return x + 1; }
static int h_api(int x) { return x ^ 0x5A5A; }
static int h_static(int x) { return (x << 1) | 1; }
static int h_admin(int x) { return x * 3 + 7; }
typedef int (*route_fn)(int);
static route_fn routes[4] = {h_root, h_api, h_static, h_admin};

/* Canonical request templates: real servers see a small working set of
 * endpoints replayed over and over, so method/route/header layout is highly
 * *correlated* across requests. A history-based predictor should learn this;
 * only the variable field bytes stay hard. (Pure-random requests would sit at
 * the entropy floor and tell us nothing about predictor quality.) */
struct http_tmpl {
    const char *line;   /* request line */
    int nhdr;           /* fixed header count */
    int content_len;    /* fixed body length */
};
static const struct http_tmpl HTTP_TMPLS[8] = {
    {"GET /index.html HTTP/1.1\r\n", 4, 0},
    {"GET /api/v1/status HTTP/1.1\r\n", 5, 0},
    {"POST /api/v1/chat HTTP/1.1\r\n", 6, 12},
    {"GET /static/app.js HTTP/1.1\r\n", 4, 0},
    {"GET /api/v1/models HTTP/1.1\r\n", 5, 0},
    {"PUT /api/v1/cfg HTTP/1.1\r\n", 6, 8},
    {"GET /favicon.ico HTTP/1.1\r\n", 3, 0},
    {"DELETE /api/v1/key HTTP/1.1\r\n", 5, 0},
};
static const char *HTTP_KEYS[6] = {"Host: ", "Accept: ", "User-Agent: ",
                                   "Content-Length: ", "Cookie: ", "X-Req: "};

static int run_http(int requests) {
    static uint8_t buf[512];
    int acc = 0;
    int session = 0;  /* rotates through the working set with light jitter */
    for (int r = 0; r < requests; r++) {
        /* pick a template: mostly sequential session rotation (correlated),
         * with an occasional jump to another endpoint. */
        if ((lcg() & 7) == 0) session = lcg() % 8;
        else session = (session + 1) % 8;
        const struct http_tmpl *t = &HTTP_TMPLS[session];
        int n = 0;
        for (const char *s = t->line; *s; s++) buf[n++] = (uint8_t)*s;
        int content_len = t->content_len;
        for (int h = 0; h < t->nhdr && n < 460; h++) {
            const char *k = HTTP_KEYS[h % 6];   /* fixed header order per template */
            for (const char *s = k; *s; s++) buf[n++] = (uint8_t)*s;
            if (k[0] == 'C' && k[1] == 'o' && k[2] == 'n') {
                char num[8]; int nn = 0, v = content_len;
                if (!v) num[nn++] = '0';
                while (v) { num[nn++] = (char)('0' + v % 10); v /= 10; }
                for (int j = nn - 1; j >= 0; j--) buf[n++] = (uint8_t)num[j];
            } else {
                int vl = 6 + (h * 2);            /* deterministic value length */
                for (int i = 0; i < vl; i++) buf[n++] = (uint8_t)('A' + ((h + i) % 26));
            }
            buf[n++] = '\r'; buf[n++] = '\n';
        }
        buf[n++] = '\r'; buf[n++] = '\n';
        for (int i = 0; i < content_len && n < 510; i++) buf[n++] = (uint8_t)('a' + (i % 26));

        /* parse: method, then header state machine, then route */
        int method = http_method(buf, n);
        int i = 0;
        while (i < n && buf[i] != ' ') i++;       /* skip method */
        i++;
        int path0 = (i < n) ? buf[i] : 0;          /* first path char */
        /* header scan: count colons and CRLFs (branchy byte loop) */
        int colons = 0, crlf = 0;
        for (int j = i; j < n; j++) {
            uint8_t c = buf[j];
            if (c == ':') colons++;
            else if (c == '\r') { if (j + 1 < n && buf[j + 1] == '\n') crlf++; }
        }
        int route = (path0 ^ method ^ colons) & 3;
        acc += routes[route](method * 16 + crlf);  /* indirect dispatch */
    }
    return acc;
}

/* ===================== 1. text / log line scanner ====================== */
/* Log lines follow a small set of format templates (real logs are highly
 * templated). Each template fixes the field-KIND sequence, so the parser's
 * classify branches become predictable given the template — history-learnable
 * structure rather than random field types. Kinds: 0=int 1=float 2=word. */
static const char *TEXT_TMPLS[6] = {
    "0220",   /* ts, level-word, code-int, msg-int */
    "021",    /* ts, level-word, float */
    "0202",   /* two ts/code ints around a word */
    "0122",   /* int, float, word, word */
    "00021",  /* metric burst: three ints, word, float */
    "021212", /* alternating */
};

static int run_text(int lines) {
    static uint8_t line[256];
    long acc = 0;
    int tmpl = 0;
    for (int r = 0; r < lines; r++) {
        /* rotate templates with occasional jump (correlated stream) */
        if ((lcg() & 15) == 0) tmpl = lcg() % 6;
        else tmpl = (tmpl + 1) % 6;
        const char *spec = TEXT_TMPLS[tmpl];
        int fields = (int)strlen(spec);
        int n = 0;
        for (int f = 0; f < fields && n < 230; f++) {
            int kind = spec[f] - '0';
            if (kind == 0) {                 /* integer field */
                int v = lcg() % 100000;
                char num[8]; int nn = 0;
                if (!v) num[nn++] = '0';
                while (v) { num[nn++] = (char)('0' + v % 10); v /= 10; }
                for (int j = nn - 1; j >= 0; j--) line[n++] = (uint8_t)num[j];
            } else if (kind == 1) {          /* float field */
                int a = lcg() % 1000, b = lcg() % 1000;
                char num[16]; int nn = 0; int v = a;
                if (!v) num[nn++] = '0';
                while (v) { num[nn++] = (char)('0' + v % 10); v /= 10; }
                for (int j = nn - 1; j >= 0; j--) line[n++] = (uint8_t)num[j];
                line[n++] = '.';
                line[n++] = (uint8_t)('0' + (b / 100));
            } else {                          /* word field */
                int wl = 2 + (lcg() % 10);
                for (int i = 0; i < wl; i++) line[n++] = (uint8_t)('a' + (lcg() % 26));
            }
            line[n++] = ',';
        }
        /* scan: split on commas, classify+parse each field (data-dependent) */
        int start = 0;
        for (int j = 0; j <= n; j++) {
            if (j == n || line[j] == ',') {
                int len = j - start;
                if (len > 0) {
                    uint8_t c0 = line[start];
                    if (c0 >= '0' && c0 <= '9') {
                        int isfloat = 0, val = 0;
                        for (int k = start; k < j; k++) {
                            if (line[k] == '.') { isfloat = 1; }
                            else if (line[k] >= '0' && line[k] <= '9') val = val * 10 + (line[k] - '0');
                        }
                        acc += isfloat ? (val * 2) : val;
                    } else {
                        for (int k = start; k < j; k++) acc += (line[k] | 0x20);
                    }
                }
                start = j + 1;
            }
        }
    }
    return (int)acc;
}

/* ===================== 2. TLV binary container walk ==================== */
static uint32_t crc_step(uint32_t crc, uint8_t b) {
    crc ^= b;
    for (int k = 0; k < 8; k++)
        crc = (crc & 1) ? (crc >> 1) ^ 0xEDB88320u : (crc >> 1);  /* data-dependent */
    return crc;
}

static int run_fileio(int records) {
    static uint8_t blob[1024];
    uint32_t crc = 0xFFFFFFFFu;
    int valid = 0, skipped = 0;
    for (int r = 0; r < records; r++) {
        /* build one TLV record: [magic:1][type:1][len:2][payload] */
        int n = 0;
        int good_magic = (lcg() % 8) != 0;            /* mostly valid */
        blob[n++] = good_magic ? 0xE1 : 0x00;
        int type = lcg() % 6;
        blob[n++] = (uint8_t)type;
        int len = lcg() % 200;
        blob[n++] = (uint8_t)(len & 0xFF);
        blob[n++] = (uint8_t)(len >> 8);
        for (int i = 0; i < len; i++) blob[n++] = (uint8_t)(lcg() & 0xFF);

        /* walk/validate: magic check, type dispatch, CRC over payload */
        int i = 0;
        if (blob[i++] != 0xE1) { skipped++; continue; }
        int t = blob[i++];
        int L = blob[i] | (blob[i + 1] << 8); i += 2;
        switch (t) {                                   /* record-type switch */
        case 0: case 1:                                /* header/index */
            for (int k = 0; k < L; k++) crc = crc_step(crc, blob[i + k]);
            valid++;
            break;
        case 2:                                        /* data chunk */
            for (int k = 0; k < L; k += 2) crc = crc_step(crc, blob[i + k]);
            valid++;
            break;
        case 3: case 4:                                /* metadata */
            for (int k = 0; k < L; k++) if (blob[i + k] & 1) crc = crc_step(crc, blob[i + k]);
            valid++;
            break;
        default:                                       /* unknown -> skip */
            skipped++;
            break;
        }
    }
    return (int)(crc ^ (uint32_t)valid ^ (uint32_t)skipped);
}

/* ===================== 3. block video decode (VLC/RLE) ================= */
static const uint8_t zigzag[16] = {0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15};

static int run_video(int blocks) {
    int16_t coeff[16];
    long acc = 0;
    for (int b = 0; b < blocks; b++) {
        /* variable-length symbol decode: run-length of zeros + level, with a
         * data-dependent number of nonzero coeffs (mimics CAVLC/RLE). */
        for (int i = 0; i < 16; i++) coeff[i] = 0;
        int pos = 0, nnz = 1 + (lcg() % 12);
        for (int s = 0; s < nnz && pos < 16; s++) {
            int run = lcg() % (16 - pos);              /* zeros to skip */
            pos += run;
            if (pos >= 16) break;
            int level = (int)(lcg() % 64) - 32;
            if (level == 0) level = 1;
            coeff[zigzag[pos]] = (int16_t)level;
            pos++;
        }
        /* dequant + a 1-D IDCT-ish butterfly with clamping (branchy) */
        for (int i = 0; i < 16; i++) {
            int v = coeff[i] * (1 + (i & 3));
            if (v > 255) v = 255;
            else if (v < -255) v = -255;
            coeff[i] = (int16_t)v;
        }
        for (int i = 0; i < 8; i++) {
            int a = coeff[i], d = coeff[15 - i];
            int s0 = a + d, s1 = a - d;
            coeff[i] = (int16_t)((s0 > 255) ? 255 : (s0 < -255 ? -255 : s0));
            coeff[15 - i] = (int16_t)((s1 > 255) ? 255 : (s1 < -255 ? -255 : s1));
        }
        for (int i = 0; i < 16; i++) acc += coeff[i];
    }
    return (int)acc;
}

/* ===================== 4. audio frame decode =========================== */
static int run_audio(int frames) {
    static int32_t band[32];
    long acc = 0;
    /* Integer sinusoid oscillators (Chebyshev recurrence) give a smooth,
     * correlated signal — real audio, not white noise. The quantizer ladder
     * then follows the slowly-varying envelope, so its branch outcomes form
     * long predictable runs a good predictor can exploit. */
    int32_t osc1 = 1000, osc1p = 0;     /* low-freq carrier */
    int32_t osc2 = 600, osc2p = 0;      /* higher partial */
    const int k1 = 250, k2 = 230;       /* 2*cos(w) in Q7-ish */
    int active = 24;                    /* steady active-subband count */
    for (int f = 0; f < frames; f++) {
        /* advance oscillators; envelope drifts smoothly over frames */
        int32_t n1 = (k1 * osc1 >> 7) - osc1p; osc1p = osc1; osc1 = n1;
        int32_t n2 = (k2 * osc2 >> 7) - osc2p; osc2p = osc2; osc2 = n2;
        if (osc1 > 1200) osc1 = 1200; else if (osc1 < -1200) osc1 = -1200;
        if (osc2 > 800) osc2 = 800; else if (osc2 < -800) osc2 = -800;
        /* envelope slowly opens/closes the active band count */
        active = 16 + (((osc1 >> 6) + 20) % 16);
        for (int s = 0; s < 32; s++) {
            if (s >= active) { band[s] = 0; continue; }   /* dead subband */
            int sample = (osc1 + (osc2 >> 1)) + (s * (osc2 >> 4));
            int mag = sample < 0 ? -sample : sample;
            /* quantizer index tracks magnitude (envelope) -> correlated runs */
            int q = (mag >> 5) & 63;
            int v;
            if (q < 4) v = sample >> 4;
            else if (q < 16) v = sample >> 2;
            else if (q < 32) v = sample;
            else if (q < 48) v = sample << 1;
            else v = sample << 2;
            if (v > 32767) v = 32767;
            else if (v < -32768) v = -32768;
            band[s] = v;
        }
        /* synthesis filter: cascaded accumulate with saturation */
        int32_t state = 0;
        for (int s = 0; s < 32; s++) {
            state = (state * 3 + band[s]) >> 2;
            if (state > 32767) state = 32767;
            else if (state < -32768) state = -32768;
            acc += state;
        }
    }
    return (int)acc;
}

int main(int argc, char **argv) {
    int scale = (argc > 1) ? atoi_simple(argv[1]) : 20000;
    int mode = (argc > 2) ? atoi_simple(argv[2]) : 0;
    int out = 0;
    switch (mode) {
    case 0: out = run_http(scale); break;
    case 1: out = run_text(scale); break;
    case 2: out = run_fileio(scale); break;
    case 3: out = run_video(scale); break;
    case 4: out = run_audio(scale); break;
    default: out = run_http(scale); break;
    }
    printf("mode=%d out=%d\n", mode, out);
    return 0;
}
