// whisper-eliza-adapter — thin C ABI on top of whisper.cpp.
//
// Exists so `bun:ffi` only has to bind four POD-argument functions instead of
// reproducing the (large) whisper_context_params / whisper_full_params structs
// across every platform we ship to. Wraps whisper.cpp's C API; nothing
// product-specific lives here.
//
// Build:  CMakeLists.txt in this directory ties the adapter to the libwhisper
//         target produced by build-whisper.mjs (or a vendored whisper.cpp
//         source dir referenced via WHISPER_CPP_SRC_DIR).
// Loaded: plugins/plugin-local-inference/src/services/voice/whisper-cpp-asr.ts
//         dlopens libwhisper_eliza_adapter.{so,dylib,dll}.

#ifndef WHISPER_ELIZA_ADAPTER_H
#define WHISPER_ELIZA_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  if defined(WHISPER_ELIZA_ADAPTER_BUILD)
#    define WEA_API __declspec(dllexport)
#  else
#    define WEA_API __declspec(dllimport)
#  endif
#else
#  define WEA_API __attribute__((visibility("default")))
#endif

// Opaque handle to a loaded whisper context + greedy-decode params.
typedef struct whisper_eliza_session whisper_eliza_session_t;

// Return values.
#define WEA_OK                  0
#define WEA_ERR_INVALID_ARG    -1
#define WEA_ERR_LOAD_FAILED    -2
#define WEA_ERR_DECODE_FAILED  -3
#define WEA_ERR_BUFFER_TOO_SMALL -4

// ABI version. Bump every time the surface below changes shape.
#define WHISPER_ELIZA_ADAPTER_ABI_VERSION 1

WEA_API int whisper_eliza_abi_version(void);

// Open a session against a GGUF/GGML whisper model on disk.
//   gguf_path : NUL-terminated UTF-8 path to a ggml-*.bin file (e.g.
//               ggml-base.en.bin from ggerganov/whisper.cpp on HF).
//   n_threads : number of CPU threads to use during decode (1..N).
//   use_gpu   : non-zero to enable a GPU backend if compiled in
//               (Metal on macOS, CUDA / Vulkan on Linux).
// Returns NULL on failure.
WEA_API whisper_eliza_session_t * whisper_eliza_open(
    const char * gguf_path,
    int          n_threads,
    int          use_gpu);

// Run greedy decode over the supplied 16 kHz mono fp32 PCM and copy the joined
// transcript into out_text as NUL-terminated UTF-8.
//   pcm16k     : pointer to n_samples floats in [-1, 1] at 16 kHz mono.
//   n_samples  : sample count.
//   language   : two-letter ISO 639-1 language code or "auto" / NULL.
//   translate  : non-zero to translate non-English speech to English.
//   out_text   : caller-owned buffer of at least `out_text_size` bytes.
//   out_text_size : capacity of out_text in bytes (including the NUL).
//   out_written   : on success, set to the number of bytes written
//                   excluding the NUL (i.e. strlen of the transcript).
// Returns WEA_OK on success. WEA_ERR_BUFFER_TOO_SMALL means out_text was too
// small for the transcript — out_written is set to the required size; the
// caller should re-allocate and retry. Any other negative value is a hard
// failure (model not loaded, decode error, etc.).
WEA_API int whisper_eliza_transcribe(
    whisper_eliza_session_t * session,
    const float *             pcm16k,
    size_t                    n_samples,
    const char *              language,
    int                       translate,
    char *                    out_text,
    size_t                    out_text_size,
    size_t *                  out_written);

// Release everything owned by the session. After this call the handle is
// invalid; passing it to any other function is undefined behaviour. Idempotent
// only in the sense that NULL is accepted (the call is a no-op).
WEA_API void whisper_eliza_close(whisper_eliza_session_t * session);

#ifdef __cplusplus
}
#endif

#endif // WHISPER_ELIZA_ADAPTER_H
