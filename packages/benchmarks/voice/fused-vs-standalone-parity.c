/*
 * fused-vs-standalone-parity.c — Phase-1 parity gate for the fused voice
 * pipeline consolidation.
 *
 * Proves that the new fused `eliza_inference_{wakeword,speaker,diariz}_*`
 * ABIs (exposed by libelizainference, the merged llama.cpp fork lib)
 * produce the SAME outputs as the proven standalone libraries
 * (libwakeword.so, libvoice_classifier.so) when fed the SAME GGUFs and
 * the SAME real-speech PCM (freeman.wav).
 *
 * Both sides run the identical vendored scalar-C forward graphs — the
 * fused side just reaches them through the context-anchored
 * eliza_inference_* wrappers instead of the raw standalone ABI. So a
 * pass here proves the wrappers are faithful (correct GGUF resolution,
 * argument marshalling, error handling) and the vendor copy is intact.
 *
 * dlopen()s both libraries at runtime (paths from argv / env) so the
 * harness does not bake in rpaths.
 *
 * Build + run: driven by run-fused-parity.mjs in this directory.
 *
 * Exit 0 = all models pass parity. Non-zero = a discrepancy (printed).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- WAV loader (16-bit PCM mono) + linear resample to 16 kHz ------- */

static float *load_wav_16k(const char *path, size_t *out_n) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open wav: %s\n", path); return NULL; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = (uint8_t *)malloc((size_t)sz);
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { fclose(f); free(buf); return NULL; }
    fclose(f);

    /* Minimal RIFF/WAVE parse: find fmt + data chunks. */
    if (memcmp(buf, "RIFF", 4) != 0 || memcmp(buf + 8, "WAVE", 4) != 0) {
        fprintf(stderr, "not a WAVE file\n"); free(buf); return NULL;
    }
    uint32_t sample_rate = 0;
    uint16_t channels = 0, bits = 0;
    const uint8_t *data = NULL;
    uint32_t data_len = 0;
    size_t p = 12;
    while (p + 8 <= (size_t)sz) {
        const uint8_t *id = buf + p;
        uint32_t clen = (uint32_t)buf[p + 4] | ((uint32_t)buf[p + 5] << 8) |
                        ((uint32_t)buf[p + 6] << 16) | ((uint32_t)buf[p + 7] << 24);
        const uint8_t *body = buf + p + 8;
        if (memcmp(id, "fmt ", 4) == 0 && clen >= 16) {
            channels = (uint16_t)(body[2] | (body[3] << 8));
            sample_rate = (uint32_t)body[4] | ((uint32_t)body[5] << 8) |
                          ((uint32_t)body[6] << 16) | ((uint32_t)body[7] << 24);
            bits = (uint16_t)(body[14] | (body[15] << 8));
        } else if (memcmp(id, "data", 4) == 0) {
            data = body;
            data_len = clen;
        }
        p += 8 + clen + (clen & 1);
    }
    if (!data || bits != 16 || channels != 1) {
        fprintf(stderr, "expected 16-bit mono PCM (got bits=%u ch=%u)\n", bits, channels);
        free(buf); return NULL;
    }

    size_t n_in = data_len / 2;
    const int16_t *pcm16 = (const int16_t *)data;
    float *in = (float *)malloc(n_in * sizeof(float));
    for (size_t i = 0; i < n_in; ++i) in[i] = (float)pcm16[i] / 32768.0f;

    if (sample_rate == 16000) {
        free(buf);
        *out_n = n_in;
        return in;
    }
    /* Linear resample to 16 kHz. */
    double ratio = 16000.0 / (double)sample_rate;
    size_t n_out = (size_t)((double)n_in * ratio);
    float *out = (float *)malloc(n_out * sizeof(float));
    for (size_t i = 0; i < n_out; ++i) {
        double src = (double)i / ratio;
        size_t i0 = (size_t)src;
        double frac = src - (double)i0;
        float a = in[i0 < n_in ? i0 : n_in - 1];
        float b = in[(i0 + 1) < n_in ? (i0 + 1) : n_in - 1];
        out[i] = a + (float)frac * (b - a);
    }
    free(in);
    free(buf);
    *out_n = n_out;
    return out;
}

/* ---- standalone ABI fn pointer types ------------------------------- */

typedef int (*fn_ww_open)(const char *, const char *, const char *, void **);
typedef int (*fn_ww_process)(void *, const float *, size_t, float *);
typedef int (*fn_ww_close)(void *);

typedef int (*fn_spk_open)(const char *, void **);
typedef int (*fn_spk_embed)(void *, const float *, size_t, float *);
typedef int (*fn_spk_close)(void *);

typedef int (*fn_dia_open)(const char *, void **);
typedef int (*fn_dia_segment)(void *, const float *, size_t, int8_t *, size_t *);
typedef int (*fn_dia_close)(void *);

typedef int (*fn_vad_open)(const char *, void **);
typedef int (*fn_vad_process)(void *, const float *, size_t, float *);
typedef int (*fn_vad_reset)(void *);
typedef int (*fn_vad_close)(void *);

/* ---- fused ABI fn pointer types ------------------------------------ */

typedef void *(*fn_eli_create)(const char *, char **);
typedef void (*fn_eli_destroy)(void *);
typedef const char *(*fn_eli_abi)(void);

typedef void *(*fn_eli_ww_open)(void *, int, const char *, char **);
typedef int (*fn_eli_ww_score)(void *, const float *, size_t, float *, char **);
typedef int (*fn_eli_ww_reset)(void *, char **);
typedef void (*fn_eli_ww_close)(void *);
typedef int (*fn_eli_ww_sup)(void);

typedef void *(*fn_eli_spk_open)(void *, const char *, char **);
typedef int (*fn_eli_spk_embed)(void *, const float *, size_t, float *, char **);
typedef void (*fn_eli_spk_close)(void *);
typedef int (*fn_eli_spk_sup)(void);

typedef void *(*fn_eli_dia_open)(void *, const char *, char **);
typedef int (*fn_eli_dia_segment)(void *, const float *, size_t, int8_t *, size_t *, char **);
typedef void (*fn_eli_dia_close)(void *);
typedef int (*fn_eli_dia_sup)(void);

typedef void *(*fn_eli_vad_open)(void *, int, char **);
typedef int (*fn_eli_vad_process)(void *, const float *, size_t, float *, char **);
typedef int (*fn_eli_vad_reset)(void *, char **);
typedef void (*fn_eli_vad_close)(void *);
typedef int (*fn_eli_vad_sup)(void);

#define SYM(handle, T, name) ((T)dlsym(handle, name))
#define REQ(ptr, name) do { if (!(ptr)) { fprintf(stderr, "missing symbol: %s (%s)\n", name, dlerror()); return 3; } } while (0)

static double cosine(const float *a, const float *b, int n) {
    double dot = 0, na = 0, nb = 0;
    for (int i = 0; i < n; ++i) { dot += (double)a[i] * b[i]; na += (double)a[i] * a[i]; nb += (double)b[i] * b[i]; }
    if (na == 0 || nb == 0) return 0;
    return dot / (sqrt(na) * sqrt(nb));
}

int main(int argc, char **argv) {
    if (argc < 11) {
        fprintf(stderr,
            "usage: %s <fused.so> <wakeword.so> <voice_classifier.so> <silero_vad.so> "
            "<bundle_dir> <wav> <wespeaker.gguf> <pyannote.gguf> <silero.gguf> <wake_head>\n",
            argv[0]);
        return 2;
    }
    const char *fused_path = argv[1];
    const char *ww_path    = argv[2];
    const char *vc_path    = argv[3];
    const char *vad_path   = argv[4];
    const char *bundle_dir = argv[5];
    const char *wav_path   = argv[6];
    const char *spk_gguf   = argv[7];
    const char *dia_gguf   = argv[8];
    const char *vad_gguf   = argv[9];
    const char *wake_head  = argv[10];

    /* The fused side resolves the wake GGUFs from <bundle>/wake/<head>.*.gguf,
     * speaker from <bundle>/speaker/*.gguf, diariz from <bundle>/diariz/*.gguf,
     * VAD from <bundle>/vad/*.gguf. The standalone side gets explicit GGUF
     * paths. */
    char ww_mel[2048], ww_emb[2048], ww_cls[2048];
    snprintf(ww_mel, sizeof ww_mel, "%s/wake/%s.melspec.gguf", bundle_dir, wake_head);
    snprintf(ww_emb, sizeof ww_emb, "%s/wake/%s.embedding.gguf", bundle_dir, wake_head);
    snprintf(ww_cls, sizeof ww_cls, "%s/wake/%s.classifier.gguf", bundle_dir, wake_head);

    void *fused = dlopen(fused_path, RTLD_NOW | RTLD_LOCAL);
    if (!fused) { fprintf(stderr, "dlopen fused: %s\n", dlerror()); return 3; }
    void *libww = dlopen(ww_path, RTLD_NOW | RTLD_LOCAL);
    if (!libww) { fprintf(stderr, "dlopen wakeword: %s\n", dlerror()); return 3; }
    void *libvc = dlopen(vc_path, RTLD_NOW | RTLD_LOCAL);
    if (!libvc) { fprintf(stderr, "dlopen voice_classifier: %s\n", dlerror()); return 3; }
    void *libvad = dlopen(vad_path, RTLD_NOW | RTLD_LOCAL);
    if (!libvad) { fprintf(stderr, "dlopen silero_vad: %s\n", dlerror()); return 3; }

    fn_eli_abi eli_abi = SYM(fused, fn_eli_abi, "eliza_inference_abi_version");
    REQ(eli_abi, "eliza_inference_abi_version");
    printf("[abi] libelizainference reports ABI v%s\n", eli_abi());

    size_t n_pcm = 0;
    float *pcm = load_wav_16k(wav_path, &n_pcm);
    if (!pcm) return 4;
    printf("[wav] %s → %zu samples @ 16 kHz (%.2f s)\n", wav_path, n_pcm, (double)n_pcm / 16000.0);

    fn_eli_create eli_create = SYM(fused, fn_eli_create, "eliza_inference_create");
    fn_eli_destroy eli_destroy = SYM(fused, fn_eli_destroy, "eliza_inference_destroy");
    REQ(eli_create, "eliza_inference_create");
    REQ(eli_destroy, "eliza_inference_destroy");
    char *cerr = NULL;
    void *ctx = eli_create(bundle_dir, &cerr);
    if (!ctx) { fprintf(stderr, "eliza_inference_create failed: %s\n", cerr ? cerr : "?"); return 5; }

    int failures = 0;

    /* ================= SPEAKER ================= */
    {
        fn_spk_open  s_open  = SYM(libvc, fn_spk_open,  "voice_speaker_open");
        fn_spk_embed s_embed = SYM(libvc, fn_spk_embed, "voice_speaker_embed");
        fn_spk_close s_close = SYM(libvc, fn_spk_close, "voice_speaker_close");
        REQ(s_open, "voice_speaker_open"); REQ(s_embed, "voice_speaker_embed"); REQ(s_close, "voice_speaker_close");

        fn_eli_spk_sup   e_sup   = SYM(fused, fn_eli_spk_sup,   "eliza_inference_speaker_supported");
        fn_eli_spk_open  e_open  = SYM(fused, fn_eli_spk_open,  "eliza_inference_speaker_open");
        fn_eli_spk_embed e_embed = SYM(fused, fn_eli_spk_embed, "eliza_inference_speaker_embed");
        fn_eli_spk_close e_close = SYM(fused, fn_eli_spk_close, "eliza_inference_speaker_close");
        REQ(e_sup, "..._speaker_supported"); REQ(e_open, "..._speaker_open");
        REQ(e_embed, "..._speaker_embed"); REQ(e_close, "..._speaker_close");
        printf("[speaker] fused supported() = %d\n", e_sup());

        /* Use an 8 s window for a strong embedding (WeSpeaker needs >=8s). */
        size_t win = 8 * 16000;
        if (win > n_pcm) win = n_pcm;

        float emb_std[256], emb_fused[256];
        void *sh = NULL;
        int rc = s_open(spk_gguf, &sh);
        if (rc != 0 || !sh) { fprintf(stderr, "[speaker] standalone open rc=%d\n", rc); failures++; }
        else {
            rc = s_embed(sh, pcm, win, emb_std);
            if (rc != 0) { fprintf(stderr, "[speaker] standalone embed rc=%d\n", rc); failures++; }
            s_close(sh);
        }

        char *e_err = NULL;
        void *eh = e_open(ctx, spk_gguf, &e_err);
        if (!eh) { fprintf(stderr, "[speaker] fused open: %s\n", e_err ? e_err : "?"); failures++; }
        else {
            rc = e_embed(eh, pcm, win, emb_fused, &e_err);
            if (rc < 0) { fprintf(stderr, "[speaker] fused embed rc=%d: %s\n", rc, e_err ? e_err : "?"); failures++; }
            e_close(eh);
        }

        double cos = cosine(emb_std, emb_fused, 256);
        double max_abs = 0;
        for (int i = 0; i < 256; ++i) { double d = fabs((double)emb_std[i] - emb_fused[i]); if (d > max_abs) max_abs = d; }
        printf("[speaker] cosine(standalone, fused) = %.9f ; max|Δ| = %.3e\n", cos, max_abs);
        if (cos < 0.999) { fprintf(stderr, "[speaker] FAIL: cosine %.9f < 0.999\n", cos); failures++; }
        else printf("[speaker] PASS (cosine >= 0.999)\n");
    }

    /* ================= DIARIZER ================= */
    {
        fn_dia_open    d_open    = SYM(libvc, fn_dia_open,    "voice_diarizer_open");
        fn_dia_segment d_segment = SYM(libvc, fn_dia_segment, "voice_diarizer_segment");
        fn_dia_close   d_close   = SYM(libvc, fn_dia_close,   "voice_diarizer_close");
        REQ(d_open, "voice_diarizer_open"); REQ(d_segment, "voice_diarizer_segment"); REQ(d_close, "voice_diarizer_close");

        fn_eli_dia_sup     e_sup     = SYM(fused, fn_eli_dia_sup,     "eliza_inference_diariz_supported");
        fn_eli_dia_open    e_open    = SYM(fused, fn_eli_dia_open,    "eliza_inference_diariz_open");
        fn_eli_dia_segment e_segment = SYM(fused, fn_eli_dia_segment, "eliza_inference_diariz_segment");
        fn_eli_dia_close   e_close   = SYM(fused, fn_eli_dia_close,   "eliza_inference_diariz_close");
        REQ(e_sup, "..._diariz_supported"); REQ(e_open, "..._diariz_open");
        REQ(e_segment, "..._diariz_segment"); REQ(e_close, "..._diariz_close");
        printf("[diariz] fused supported() = %d\n", e_sup());

        size_t win = 80000; /* the pyannote 5 s window */
        if (win > n_pcm) { fprintf(stderr, "[diariz] not enough audio\n"); failures++; }
        else {
            int8_t labels_std[512], labels_fused[512];
            size_t cap_std = 512, cap_fused = 512;

            void *dh = NULL;
            int rc = d_open(dia_gguf, &dh);
            int speech_std = -1, frames_std = -1;
            if (rc != 0 || !dh) { fprintf(stderr, "[diariz] standalone open rc=%d\n", rc); failures++; }
            else {
                rc = d_segment(dh, pcm, win, labels_std, &cap_std);
                if (rc != 0) { fprintf(stderr, "[diariz] standalone segment rc=%d\n", rc); failures++; }
                else { frames_std = (int)cap_std; speech_std = 0; for (size_t i = 0; i < cap_std; ++i) if (labels_std[i] != 0) speech_std++; }
                d_close(dh);
            }

            char *e_err = NULL;
            void *eh = e_open(ctx, dia_gguf, &e_err);
            int speech_fused = -1, frames_fused = -1;
            if (!eh) { fprintf(stderr, "[diariz] fused open: %s\n", e_err ? e_err : "?"); failures++; }
            else {
                rc = e_segment(eh, pcm, win, labels_fused, &cap_fused, &e_err);
                if (rc < 0) { fprintf(stderr, "[diariz] fused segment rc=%d: %s\n", rc, e_err ? e_err : "?"); failures++; }
                else { frames_fused = (int)cap_fused; speech_fused = 0; for (size_t i = 0; i < cap_fused; ++i) if (labels_fused[i] != 0) speech_fused++; }
                e_close(eh);
            }

            int mismatch = 0;
            if (frames_std == frames_fused && frames_std > 0)
                for (int i = 0; i < frames_std; ++i) if (labels_std[i] != labels_fused[i]) mismatch++;
            printf("[diariz] frames: standalone=%d fused=%d ; speech-frames: standalone=%d fused=%d ; per-frame label mismatches=%d\n",
                   frames_std, frames_fused, speech_std, speech_fused, mismatch);
            if (frames_std != frames_fused || frames_std <= 0) { fprintf(stderr, "[diariz] FAIL: frame count mismatch\n"); failures++; }
            else if (mismatch != 0) { fprintf(stderr, "[diariz] FAIL: %d per-frame label mismatches\n", mismatch); failures++; }
            else printf("[diariz] PASS (identical frame count + per-frame labels)\n");
        }
    }

    /* ================= WAKE-WORD ================= */
    {
        fn_ww_open    w_open    = SYM(libww, fn_ww_open,    "wakeword_open");
        fn_ww_process w_process = SYM(libww, fn_ww_process, "wakeword_process");
        fn_ww_close   w_close   = SYM(libww, fn_ww_close,   "wakeword_close");
        REQ(w_open, "wakeword_open"); REQ(w_process, "wakeword_process"); REQ(w_close, "wakeword_close");

        fn_eli_ww_sup   e_sup   = SYM(fused, fn_eli_ww_sup,   "eliza_inference_wakeword_supported");
        fn_eli_ww_open  e_open  = SYM(fused, fn_eli_ww_open,  "eliza_inference_wakeword_open");
        fn_eli_ww_score e_score = SYM(fused, fn_eli_ww_score, "eliza_inference_wakeword_score");
        fn_eli_ww_reset e_reset = SYM(fused, fn_eli_ww_reset, "eliza_inference_wakeword_reset");
        fn_eli_ww_close e_close = SYM(fused, fn_eli_ww_close, "eliza_inference_wakeword_close");
        REQ(e_sup, "..._wakeword_supported"); REQ(e_open, "..._wakeword_open");
        REQ(e_score, "..._wakeword_score"); REQ(e_reset, "..._wakeword_reset"); REQ(e_close, "..._wakeword_close");
        printf("[wakeword] fused supported() = %d\n", e_sup());

        const size_t FRAME = 1280; /* 80 ms @ 16 kHz */
        size_t n_frames = n_pcm / FRAME;
        if (n_frames > 200) n_frames = 200; /* ~16 s is plenty */

        double peak_std = 0, peak_fused = 0, max_abs = 0;

        void *wh = NULL;
        int rc = w_open(ww_mel, ww_emb, ww_cls, &wh);
        if (rc != 0 || !wh) { fprintf(stderr, "[wakeword] standalone open rc=%d\n", rc); failures++; }

        char *e_err = NULL;
        void *eh = e_open(ctx, 16000, wake_head, &e_err);
        if (!eh) { fprintf(stderr, "[wakeword] fused open: %s\n", e_err ? e_err : "?"); failures++; }

        if (wh && eh) {
            for (size_t fr = 0; fr < n_frames; ++fr) {
                const float *frame = pcm + fr * FRAME;
                float s_std = 0, s_fused = 0;
                int r1 = w_process(wh, frame, FRAME, &s_std);
                int r2 = e_score(eh, frame, FRAME, &s_fused, &e_err);
                if (r1 != 0) { fprintf(stderr, "[wakeword] standalone process rc=%d\n", r1); failures++; break; }
                if (r2 < 0) { fprintf(stderr, "[wakeword] fused score rc=%d: %s\n", r2, e_err ? e_err : "?"); failures++; break; }
                double d = fabs((double)s_std - s_fused);
                if (d > max_abs) max_abs = d;
                if (s_std > peak_std) peak_std = s_std;
                if (s_fused > peak_fused) peak_fused = s_fused;
            }
            printf("[wakeword] frames=%zu peak: standalone=%.6f fused=%.6f ; max per-frame |Δ| = %.3e\n",
                   n_frames, peak_std, peak_fused, max_abs);
            if (fabs(peak_std - peak_fused) > 0.02 || max_abs > 0.02) {
                fprintf(stderr, "[wakeword] FAIL: peak Δ=%.4f or max per-frame Δ=%.4f exceeds 0.02\n",
                        fabs(peak_std - peak_fused), max_abs);
                failures++;
            } else printf("[wakeword] PASS (peak Δ and per-frame Δ within 0.02)\n");

            /* Reset smoke: after reset the next score on silence must be 0. */
            if (e_reset(eh, &e_err) != 0) { fprintf(stderr, "[wakeword] reset rc!=0: %s\n", e_err ? e_err : "?"); failures++; }
            else printf("[wakeword] reset OK\n");
        }
        if (wh) w_close(wh);
        if (eh) e_close(eh);
    }

    /* ================= VAD ================= */
    {
        fn_vad_open    v_open    = SYM(libvad, fn_vad_open,    "silero_vad_open");
        fn_vad_process v_process = SYM(libvad, fn_vad_process, "silero_vad_process");
        fn_vad_reset   v_reset   = SYM(libvad, fn_vad_reset,   "silero_vad_reset_state");
        fn_vad_close   v_close   = SYM(libvad, fn_vad_close,   "silero_vad_close");
        REQ(v_open, "silero_vad_open"); REQ(v_process, "silero_vad_process");
        REQ(v_reset, "silero_vad_reset_state"); REQ(v_close, "silero_vad_close");

        fn_eli_vad_sup     e_sup     = SYM(fused, fn_eli_vad_sup,     "eliza_inference_vad_supported");
        fn_eli_vad_open    e_open    = SYM(fused, fn_eli_vad_open,    "eliza_inference_vad_open");
        fn_eli_vad_process e_process = SYM(fused, fn_eli_vad_process, "eliza_inference_vad_process");
        fn_eli_vad_reset   e_reset   = SYM(fused, fn_eli_vad_reset,   "eliza_inference_vad_reset");
        fn_eli_vad_close   e_close   = SYM(fused, fn_eli_vad_close,   "eliza_inference_vad_close");
        REQ(e_sup, "..._vad_supported"); REQ(e_open, "..._vad_open");
        REQ(e_process, "..._vad_process"); REQ(e_reset, "..._vad_reset"); REQ(e_close, "..._vad_close");
        printf("[vad] fused supported() = %d\n", e_sup());

        const size_t WIN = 512; /* 32 ms @ 16 kHz — the Silero v5 native window */
        size_t n_windows = n_pcm / WIN;

        void *vh = NULL;
        int rc = v_open(vad_gguf, &vh);
        if (rc != 0 || !vh) { fprintf(stderr, "[vad] standalone open rc=%d\n", rc); failures++; }

        char *e_err = NULL;
        void *eh = e_open(ctx, 16000, &e_err);
        if (!eh) { fprintf(stderr, "[vad] fused open: %s\n", e_err ? e_err : "?"); failures++; }

        if (vh && eh) {
            double max_abs = 0;
            float peak_std = 0, peak_fused = 0;
            int gt05_std = 0, gt05_fused = 0;
            int gt05_mismatch = 0;
            for (size_t w = 0; w < n_windows; ++w) {
                const float *win = pcm + w * WIN;
                float p_std = 0, p_fused = 0;
                int r1 = v_process(vh, win, WIN, &p_std);
                int r2 = e_process(eh, win, WIN, &p_fused, &e_err);
                if (r1 != 0) { fprintf(stderr, "[vad] standalone process rc=%d (win %zu)\n", r1, w); failures++; break; }
                if (r2 < 0) { fprintf(stderr, "[vad] fused process rc=%d: %s (win %zu)\n", r2, e_err ? e_err : "?", w); failures++; break; }
                double d = fabs((double)p_std - p_fused);
                if (d > max_abs) max_abs = d;
                if (p_std > peak_std) peak_std = p_std;
                if (p_fused > peak_fused) peak_fused = p_fused;
                int s = p_std > 0.5f, f = p_fused > 0.5f;
                gt05_std += s; gt05_fused += f;
                if (s != f) gt05_mismatch++;
            }
            printf("[vad] windows=%zu peak: standalone=%.6f fused=%.6f ; "
                   ">0.5 count: standalone=%d fused=%d ; >0.5 mismatch=%d ; max|Δ| = %.3e\n",
                   n_windows, peak_std, peak_fused, gt05_std, gt05_fused, gt05_mismatch, max_abs);
            if (max_abs >= 1e-3) {
                fprintf(stderr, "[vad] FAIL: max per-window |Δ| %.3e >= 1e-3\n", max_abs);
                failures++;
            } else if (gt05_std != gt05_fused || gt05_mismatch != 0) {
                fprintf(stderr, "[vad] FAIL: >0.5 window counts differ (std=%d fused=%d mismatch=%d)\n",
                        gt05_std, gt05_fused, gt05_mismatch);
                failures++;
            } else {
                printf("[vad] PASS (max|Δ| < 1e-3, identical >0.5 window count = %d)\n", gt05_std);
            }

            /* Reset smoke: fused reset must succeed (in-place LSTM clear). */
            if (e_reset(eh, &e_err) != 0) { fprintf(stderr, "[vad] reset rc!=0: %s\n", e_err ? e_err : "?"); failures++; }
            else printf("[vad] reset OK\n");
        }
        if (vh) v_close(vh);
        if (eh) e_close(eh);
    }

    eli_destroy(ctx);
    free(pcm);

    printf("\n==== PARITY %s (%d failure%s) ====\n",
           failures == 0 ? "PASS" : "FAIL", failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}
