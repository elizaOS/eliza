/*
 * Internal layout shared by the wakeword runtime TUs.
 *
 * Phase 2 reconciles these constants with the openWakeWord upstream
 * exactly. The numbers are read from each GGUF's metadata at session
 * open and re-validated against these macros — a mismatch is hard
 * `-EINVAL`, never silently accepted (see `wakeword_runtime.c`).
 *
 * STFT (n_fft=512, hop=160) gives a 32 ms / 10 ms time grid at 16 kHz —
 * the openWakeWord melspectrogram time grid. The mel filter matrix is
 * NOT computed in C anymore; it loads as a (257, 32) tensor from
 * `melspec.gguf`, exactly as it appears in the upstream ONNX. The C
 * side just needs to read it back.
 *
 * Streaming hop: 80 ms (1280 samples) — one classifier evaluation per
 * 80 ms of audio, matching the openWakeWord Python reference.
 */

#ifndef WAKEWORD_INTERNAL_H
#define WAKEWORD_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

#include "wakeword/wakeword.h"

/* STFT parameters (openWakeWord upstream — locked). */
#define WW_N_FFT      512
#define WW_HOP_LEN    160
#define WW_WIN_LEN    512   /* Conv1D kernel length matches n_fft. */
#define WW_N_BINS     257   /* WW_N_FFT/2 + 1 */
#define WW_N_MELS     32

/* Embedding model inputs / outputs. */
#define WW_EMBEDDING_WINDOW 76   /* mel frames per embedding step */
#define WW_EMBEDDING_DIM    96   /* output dim of one embedding step  */

/* Classifier head. */
#define WW_HEAD_WINDOW      16   /* embeddings per classifier step    */
#define WW_HEAD_FLAT        (WW_HEAD_WINDOW * WW_EMBEDDING_DIM) /* 1536 */

/* Streaming window: 80 ms / 1280 samples per `wakeword_process` hop. */
#define WW_FRAME_SAMPLES 1280  /* 80 ms */
#define WW_FRAME_HOP     1280  /* 80 ms; no overlap */

/* dB-log floor used by the openWakeWord melspec post-processing.
 * Mirrors the ONNX `Sub_33` constant. */
#define WW_MEL_DB_FLOOR  80.0f
/* Clip floor for numerical stability before log. Mirrors ONNX
 * `Clip_39`. */
#define WW_MEL_LOG_CLIP  1e-10f

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- melspectrogram (`wakeword_melspec.c`) ---------------- */

/*
 * Streaming, GGUF-backed log-mel spectrogram. The state owns the carry
 * buffer, the dB-log post-processing reference, and pointers to the
 * mel-bank tensors loaded by the runtime — it does NOT own them, so
 * the runtime is free to keep one mel-bank in memory across multiple
 * sessions if it chooses.
 *
 * Why this is *not* in the runtime TU directly: the unit test in
 * `test/wakeword_melspec_test.c` exercises the streaming melspec on a
 * synthetic tone, without spinning up a full session. The runtime
 * builds a melspec state on top of the loaded GGUF tensors and reuses
 * the same hop/STFT plumbing the unit test does.
 */
typedef struct {
    /* Up to `WW_N_FFT - 1` carried samples from the previous call. */
    float carry[WW_N_FFT];
    size_t n_carry;

    /* Read-only borrowed pointers to the loaded tensors. The runtime
     * owns the storage; this state just reads from it. NULL when the
     * caller has not bound a GGUF (e.g. the unit test runs without a
     * GGUF — see `wakeword_melspec_use_legacy_bank`). */
    const float *stft_real;     /* (257, 1, 512) row-major */
    const float *stft_imag;     /* (257, 1, 512) row-major */
    const float *mel_filter;    /* (257, 32)     row-major */
} wakeword_melspec_state;

/*
 * Initialize a melspec state. Bind the GGUF-loaded tensors in
 * `*_tensors`; pass NULL for any of them to fall back to the C-side
 * legacy filter bank used by the unit tests (a generic 80-mel bank
 * that lights up the right bin for a 1 kHz tone). The legacy bank is
 * activated by passing all three pointers as NULL.
 */
void wakeword_melspec_state_init(wakeword_melspec_state *state,
                                 const float *stft_real_tensors,
                                 const float *stft_imag_tensors,
                                 const float *mel_filter_tensor);

/*
 * Feed an arbitrary chunk of PCM. Writes one mel column per
 * `WW_HOP_LEN` samples consumed (counting carry).
 *
 * `out_columns` MUST have space for at least
 * `wakeword_melspec_max_columns(n_samples)` mel columns of width
 * `WW_N_MELS` each. The post-processing applies the openWakeWord
 * dB-log followed by a per-call relmax floor at -80 dB:
 *   mel_db = 10 * log10(clip(mel_pow, 1e-10, inf))
 *   peak   = max(mel_db over all (T, M))
 *   out    = clip(mel_db, peak - 80, inf)
 *
 * That floor is applied per call (matches the ONNX). For the streaming
 * runtime it means short calls produce slightly different floor values
 * than long ones — the openWakeWord upstream has the same property.
 *
 * Returns 0 on success, -EINVAL on bad input, or -ENOMEM on allocation
 * failure (the workspace allocates per-call scratch space proportional
 * to the input chunk size).
 */
int wakeword_melspec_stream(wakeword_melspec_state *state,
                            const float *pcm,
                            size_t n_samples,
                            float *out_columns,
                            size_t *out_n_columns);

/*
 * Convenience: compute a single mel column from `WW_N_FFT` samples.
 * Applies the same dB-log + relmax-floor (with the per-call peak
 * being just this one column).
 */
int wakeword_melspec_column(const wakeword_melspec_state *state,
                            const float *pcm_window,
                            float *mel_out);

/* Maximum number of mel columns produced by an input chunk of
 * `n_input_samples`, bounded loosely (assumes the carry is already
 * full at WW_N_FFT - 1 samples). */
size_t wakeword_melspec_max_columns(size_t n_input_samples);

/*
 * Diagnostic: return the centre frequency (Hz) of mel bin `mel_idx`
 * **for the C-side legacy filter bank**. The unit test exercises a
 * generic 80-mel bank to validate Hann + DFT + filter-bank wiring on a
 * 1 kHz tone; the upstream-bank centres are not exposed.
 */
float wakeword_mel_bin_center_hz(int mel_idx);

/* Number of mels in the legacy (unit-test-only) filter bank. The unit
 * test uses this when iterating bins. */
#define WW_LEGACY_N_MELS 80

/* ---------------- sliding window (`wakeword_window.c`) ---------------- */

typedef struct {
    float buffer[WW_FRAME_SAMPLES];
    size_t n_buffered;
    /* Monotonic count of frames emitted across the lifetime of this
     * state. The unit test reads it to verify timing. */
    uint64_t n_frames_emitted;
} wakeword_window_state;

void wakeword_window_state_init(wakeword_window_state *state);

int wakeword_window_push(wakeword_window_state *state,
                         const float *pcm,
                         size_t n_samples,
                         float *out_frames,
                         size_t max_frames,
                         size_t *out_n_frames);

#ifdef __cplusplus
}
#endif

#endif /* WAKEWORD_INTERNAL_H */
