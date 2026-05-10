/*
 * Reference C stub of the libelizainference ABI.
 *
 * Builds into `libelizainference_stub.{dylib,so}`. The Node FFI loader
 * uses this to validate the binding layer end-to-end without requiring
 * the real fused omnivoice + llama.cpp build to exist.
 *
 * What works:
 *   - `eliza_inference_abi_version()` returns "1".
 *   - `eliza_inference_create(bundle_dir, ...)` validates the path
 *     argument and returns a tiny heap-allocated context. Bundle_dir
 *     must be non-NULL and non-empty; nothing on disk is required, so
 *     the loader test can pass an arbitrary string.
 *   - `eliza_inference_destroy()` frees the context.
 *   - `eliza_inference_free_string()` frees library-allocated strings.
 *
 * What returns ELIZA_ERR_NOT_IMPLEMENTED:
 *   - mmap_acquire / mmap_evict — the real implementation requires the
 *     fused build's mmap of the weight files.
 *   - tts_synthesize — needs OmniVoice.
 *   - asr_transcribe — needs the ASR backend.
 *
 * Per `packages/inference/AGENTS.md` §3 + §9: the stub does NOT
 * fabricate fake outputs, does NOT log, does NOT pretend success.
 * Every entry that requires the real fused build returns the
 * structured "not implemented" code with a diagnostic the binding
 * surfaces as `VoiceLifecycleError({ code: "missing-ffi" })`.
 */

#include "ffi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct EliInferenceContext {
    char * bundle_dir;
};

/* ----------------------------------------------------------------- */
/* Helpers                                                           */
/* ----------------------------------------------------------------- */

static char * dup_cstr(const char * s) {
    if (!s) return NULL;
    size_t n = strlen(s);
    char * out = (char *)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

static void set_error(char ** out_error, const char * msg) {
    if (!out_error) return;
    *out_error = dup_cstr(msg);
}

/* ----------------------------------------------------------------- */
/* ABI version                                                       */
/* ----------------------------------------------------------------- */

#define _ELIZA_STR2(x) #x
#define _ELIZA_STR(x) _ELIZA_STR2(x)
static const char * const ELIZA_ABI_VERSION_STRING = _ELIZA_STR(ELIZA_INFERENCE_ABI_VERSION);

const char * eliza_inference_abi_version(void) {
    return ELIZA_ABI_VERSION_STRING;
}

/* ----------------------------------------------------------------- */
/* Lifecycle                                                         */
/* ----------------------------------------------------------------- */

EliInferenceContext * eliza_inference_create(
    const char * bundle_dir,
    char ** out_error)
{
    if (!bundle_dir || bundle_dir[0] == '\0') {
        set_error(out_error,
            "[libelizainference-stub] eliza_inference_create: bundle_dir is required");
        return NULL;
    }
    EliInferenceContext * ctx =
        (EliInferenceContext *)calloc(1, sizeof(EliInferenceContext));
    if (!ctx) {
        set_error(out_error,
            "[libelizainference-stub] eliza_inference_create: out of memory");
        return NULL;
    }
    ctx->bundle_dir = dup_cstr(bundle_dir);
    if (!ctx->bundle_dir) {
        free(ctx);
        set_error(out_error,
            "[libelizainference-stub] eliza_inference_create: out of memory (bundle_dir)");
        return NULL;
    }
    return ctx;
}

void eliza_inference_destroy(EliInferenceContext * ctx) {
    if (!ctx) return;
    if (ctx->bundle_dir) free(ctx->bundle_dir);
    free(ctx);
}

/* ----------------------------------------------------------------- */
/* mmap acquire / evict                                              */
/* ----------------------------------------------------------------- */

static int valid_region(const char * name) {
    if (!name) return 0;
    return (strcmp(name, "tts") == 0
         || strcmp(name, "asr") == 0
         || strcmp(name, "text") == 0
         || strcmp(name, "dflash") == 0);
}

int eliza_inference_mmap_acquire(
    EliInferenceContext * ctx,
    const char * region_name,
    char ** out_error)
{
    if (!ctx) {
        set_error(out_error,
            "[libelizainference-stub] mmap_acquire: ctx is NULL");
        return ELIZA_ERR_INVALID_ARG;
    }
    if (!valid_region(region_name)) {
        set_error(out_error,
            "[libelizainference-stub] mmap_acquire: invalid region_name (expected tts|asr|text|dflash)");
        return ELIZA_ERR_INVALID_ARG;
    }
    set_error(out_error,
        "[libelizainference-stub] mmap_acquire: not implemented in stub — fused build required");
    return ELIZA_ERR_NOT_IMPLEMENTED;
}

int eliza_inference_mmap_evict(
    EliInferenceContext * ctx,
    const char * region_name,
    char ** out_error)
{
    if (!ctx) {
        set_error(out_error,
            "[libelizainference-stub] mmap_evict: ctx is NULL");
        return ELIZA_ERR_INVALID_ARG;
    }
    if (!valid_region(region_name)) {
        set_error(out_error,
            "[libelizainference-stub] mmap_evict: invalid region_name (expected tts|asr|text|dflash)");
        return ELIZA_ERR_INVALID_ARG;
    }
    set_error(out_error,
        "[libelizainference-stub] mmap_evict: not implemented in stub — fused build required");
    return ELIZA_ERR_NOT_IMPLEMENTED;
}

/* ----------------------------------------------------------------- */
/* TTS / ASR forward passes                                          */
/* ----------------------------------------------------------------- */

int eliza_inference_tts_synthesize(
    EliInferenceContext * ctx,
    const char * text,
    size_t text_len,
    const char * speaker_preset_id,
    float * out_pcm,
    size_t max_samples,
    char ** out_error)
{
    (void)speaker_preset_id;
    (void)out_pcm;
    (void)max_samples;
    if (!ctx) {
        set_error(out_error,
            "[libelizainference-stub] tts_synthesize: ctx is NULL");
        return ELIZA_ERR_INVALID_ARG;
    }
    if (!text || text_len == 0) {
        set_error(out_error,
            "[libelizainference-stub] tts_synthesize: text is required");
        return ELIZA_ERR_INVALID_ARG;
    }
    set_error(out_error,
        "[libelizainference-stub] tts_synthesize: not implemented in stub — fused build required");
    return ELIZA_ERR_NOT_IMPLEMENTED;
}

int eliza_inference_asr_transcribe(
    EliInferenceContext * ctx,
    const float * pcm,
    size_t n_samples,
    int sample_rate_hz,
    char * out_text,
    size_t max_text_bytes,
    char ** out_error)
{
    (void)sample_rate_hz;
    (void)out_text;
    (void)max_text_bytes;
    if (!ctx) {
        set_error(out_error,
            "[libelizainference-stub] asr_transcribe: ctx is NULL");
        return ELIZA_ERR_INVALID_ARG;
    }
    if (!pcm || n_samples == 0) {
        set_error(out_error,
            "[libelizainference-stub] asr_transcribe: pcm is required");
        return ELIZA_ERR_INVALID_ARG;
    }
    set_error(out_error,
        "[libelizainference-stub] asr_transcribe: not implemented in stub — fused build required");
    return ELIZA_ERR_NOT_IMPLEMENTED;
}

/* ----------------------------------------------------------------- */
/* String free                                                       */
/* ----------------------------------------------------------------- */

void eliza_inference_free_string(char * str) {
    if (str) free(str);
}
