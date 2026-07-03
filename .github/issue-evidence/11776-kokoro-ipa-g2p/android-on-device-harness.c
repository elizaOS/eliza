// On-device Android harness for #11776: dlopen the REAL fused
// libelizainference.so, load the real Kokoro model, and synthesize each phrase
// via BOTH the raw-text path (kokoroSynthesize — the espeak-less ASCII bug) and
// the IPA path (kokoroSynthesizeIpa fed espeak-ng-WASM IPA — the fix). Writes a
// WAV per (phrase,path); the host ASR-transcribes them (the exact round-trip
// that returned an EMPTY transcript in #10727's emu leg).
//
// The IPA strings are the exact output of the `phonemizer` npm package
// (espeak-ng WASM) for each phrase — i.e. what the TS voice layer feeds the FFI
// on-device.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef void *Ctx;
typedef Ctx (*create_fn)(const char *, char **);
typedef int (*supported_fn)(void);
typedef int (*g2p_fn)(Ctx);
typedef int (*load_fn)(Ctx, const char *, const char *, int, char **);
typedef int (*synth_fn)(Ctx, const char *, size_t, float, float *, size_t, char **);
typedef int (*rate_fn)(Ctx);
typedef void (*destroy_fn)(Ctx);

static void write_wav(const char *path, const float *pcm, int n, int sr) {
  FILE *f = fopen(path, "wb");
  if (!f) { printf("  ERR: cannot open %s\n", path); return; }
  int32_t byte_rate = sr * 2, data_bytes = n * 2;
  fwrite("RIFF", 1, 4, f);
  int32_t riff = 36 + data_bytes; fwrite(&riff, 4, 1, f);
  fwrite("WAVE", 1, 4, f); fwrite("fmt ", 1, 4, f);
  int32_t sub1 = 16; fwrite(&sub1, 4, 1, f);
  int16_t fmt = 1, ch = 1; fwrite(&fmt, 2, 1, f); fwrite(&ch, 2, 1, f);
  fwrite(&sr, 4, 1, f); fwrite(&byte_rate, 4, 1, f);
  int16_t blk = 2, bits = 16; fwrite(&blk, 2, 1, f); fwrite(&bits, 2, 1, f);
  fwrite("data", 1, 4, f); fwrite(&data_bytes, 4, 1, f);
  for (int i = 0; i < n; i++) {
    float s = pcm[i]; if (s > 1) s = 1; if (s < -1) s = -1;
    int16_t v = (int16_t)(s < 0 ? s * 0x8000 : s * 0x7fff);
    fwrite(&v, 2, 1, f);
  }
  fclose(f);
}

int main(int argc, char **argv) {
  if (argc < 5) {
    printf("usage: %s <lib.so> <gguf> <voice.bin> <outdir>\n", argv[0]);
    return 2;
  }
  const char *lib = argv[1], *gguf = argv[2], *voice = argv[3], *outdir = argv[4];
  void *h = dlopen(lib, RTLD_NOW | RTLD_LOCAL);
  if (!h) { printf("dlopen failed: %s\n", dlerror()); return 1; }

  create_fn create = (create_fn)dlsym(h, "eliza_inference_create");
  supported_fn supported = (supported_fn)dlsym(h, "eliza_inference_kokoro_supported");
  g2p_fn g2p = (g2p_fn)dlsym(h, "eliza_inference_kokoro_g2p_kind");
  load_fn load = (load_fn)dlsym(h, "eliza_inference_kokoro_load");
  synth_fn synth = (synth_fn)dlsym(h, "eliza_inference_kokoro_synthesize");
  synth_fn synth_ipa = (synth_fn)dlsym(h, "eliza_inference_kokoro_synthesize_ipa");
  rate_fn rate = (rate_fn)dlsym(h, "eliza_inference_kokoro_sample_rate");
  destroy_fn destroy = (destroy_fn)dlsym(h, "eliza_inference_destroy");
  const char *(*abi)(void) = (const char *(*)(void))dlsym(h, "eliza_inference_abi_version");

  printf("ABI=v%s kokoro_supported=%d\n", abi ? abi() : "?", supported ? supported() : -1);
  printf("has g2p_kind sym=%d  has synth_ipa sym=%d\n", g2p != NULL, synth_ipa != NULL);
  if (!create || !load || !synth || !synth_ipa || !g2p) {
    printf("FATAL: required symbols missing (the .so predates the IPA fix)\n");
    return 1;
  }

  char *err = NULL;
  // Anchor ctx at the kokoro model dir.
  char kdir[1024]; strncpy(kdir, gguf, sizeof(kdir) - 1);
  char *slash = strrchr(kdir, '/'); if (slash) *slash = 0;
  Ctx ctx = create(kdir, &err);
  if (!ctx) { printf("create failed: %s\n", err ? err : "?"); return 1; }

  int kind = g2p(ctx);
  printf("g2p_kind=%d (%s)\n", kind, kind == 0 ? "ASCII" : kind == 1 ? "ESPEAK" : "?");

  int rc = load(ctx, gguf, voice, 256, &err);
  if (rc != 0) { printf("kokoro_load rc=%d: %s\n", rc, err ? err : "?"); return 1; }
  int sr = rate ? rate(ctx) : 24000;

  const char *phrases[] = {
    "Hello, this is a native Kokoro voice test.",
    "The quick brown fox jumps over the lazy dog.",
    "She sells seashells by the seashore.",
  };
  // espeak-ng-WASM (npm `phonemizer`) IPA — exactly what the TS layer feeds FFI.
  const char *ipas[] = {
    "həlˈoʊ ðɪs ɪz ɐ nˈeɪɾɪv kəkˈoːɹoʊ vˈɔɪs tˈɛst",
    "ðə kwˈɪk bɹˈaʊn fˈɑːks dʒˈʌmps ˌoʊvɚ ðə lˈeɪzi dˈɑːɡ",
    "ʃiː sˈɛlz sˈiːʃɛlz baɪ ðə sˈiːʃoːɹ",
  };
  const int nph = 3;
  const size_t MAX = 30 * 24000;
  float *buf = (float *)malloc(MAX * sizeof(float));

  for (int i = 0; i < nph; i++) {
    err = NULL;
    int nraw = synth(ctx, phrases[i], strlen(phrases[i]), 1.0f, buf, MAX, &err);
    printf("[p%d] raw-text n_samples=%d %s\n", i, nraw, nraw < 0 && err ? err : "");
    if (nraw > 0) { char p[1200]; snprintf(p, sizeof(p), "%s/and-p%d-rawtext.wav", outdir, i); write_wav(p, buf, nraw, sr); }

    err = NULL;
    int nipa = synth_ipa(ctx, ipas[i], strlen(ipas[i]), 1.0f, buf, MAX, &err);
    printf("[p%d] wasm-ipa n_samples=%d %s\n", i, nipa, nipa < 0 && err ? err : "");
    if (nipa > 0) { char p[1200]; snprintf(p, sizeof(p), "%s/and-p%d-ipa.wav", outdir, i); write_wav(p, buf, nipa, sr); }
  }
  free(buf);
  if (destroy) destroy(ctx);
  printf("DONE\n");
  return 0;
}
