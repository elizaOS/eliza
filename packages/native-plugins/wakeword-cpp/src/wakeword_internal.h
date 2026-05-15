/*
 * Internal layout shared by the real (non-stub) wakeword TUs.
 *
 * The numbers in this header are the contract the streaming pipeline is
 * built against. They mirror the openWakeWord melspectrogram graph as
 * the real port will eventually re-implement it via ggml ops, plus the
 * task-brief override (80-mel / 0–8000 Hz / hop 160) the first-pass
 * pure-C reference is dimensioned around.
 *
 * STFT (n_fft=400, hop=160) gives a 25 ms / 10 ms time grid at 16 kHz
 * — that is the openWakeWord melspectrogram time grid. The first-pass
 * mel filter bank below uses 80 mels / 0–8000 Hz so the unit test can
 * assert a 1 kHz tone lights up the right mel bin without dragging the
 * full openWakeWord 32-bin float-cluster definition into pure C. Phase
 * 2 will swap this for the openWakeWord-exact 32-bin filter bank when
 * the embedding/classifier GGUFs are real.
 */

#ifndef WAKEWORD_INTERNAL_H
#define WAKEWORD_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

#include "wakeword/wakeword.h"

/* STFT parameters (16 kHz, openWakeWord time grid). */
#define WW_N_FFT      400
#define WW_HOP_LEN    160
#define WW_WIN_LEN    400  /* equal to n_fft; Hann window length. */
#define WW_N_MELS     80
#define WW_FMIN_HZ    0.0f
#define WW_FMAX_HZ    8000.0f

/* Streaming window: 80 ms frames @ 16 kHz with an 80 ms hop = no
 * overlap between successive `wakeword_window_*` emissions. The
 * embedding model upstream of this windowing layer slides at a finer
 * 10 ms cadence inside a single emitted frame; that cadence is internal
 * to the embedding TU and not exposed here. */
#define WW_FRAME_SAMPLES 1280  /* 80 ms */
#define WW_FRAME_HOP     1280  /* 80 ms */

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- melspectrogram (`wakeword_melspec.c`) ---------------- */

/*
 * Compute a single mel-spectrogram column from `WW_N_FFT` float samples
 * (already pre-windowed by the caller's STFT loop is *not* required:
 * this function applies the Hann window itself for ergonomics).
 *
 * `pcm_window` length MUST equal `WW_N_FFT`. `mel_out` length MUST
 * equal `WW_N_MELS`. Output is log-mel energy (natural log of power +
 * 1e-10 floor) — the same shape any downstream embedding CNN expects.
 *
 * Returns 0 on success, -EINVAL on bad input.
 */
int wakeword_melspec_column(const float *pcm_window, float *mel_out);

/*
 * Stream variant: feed an arbitrary chunk of PCM, the impl manages an
 * internal STFT carry buffer and writes one mel column per
 * `WW_HOP_LEN` samples consumed (counting carry).
 *
 * `out_columns` must point to space for at least
 * `wakeword_melspec_max_columns(n_samples)` mel columns
 * (each `WW_N_MELS` floats). On return, `*out_n_columns` carries the
 * actual count produced.
 *
 * Carry state lives in `state`, which the caller owns. Initialize with
 * `wakeword_melspec_state_init`.
 *
 * Returns 0 on success, -EINVAL on bad input.
 */
typedef struct {
    /* Up to `WW_N_FFT - 1` carried samples from the previous call. */
    float carry[WW_N_FFT];
    size_t n_carry;
} wakeword_melspec_state;

void wakeword_melspec_state_init(wakeword_melspec_state *state);

size_t wakeword_melspec_max_columns(size_t n_input_samples);

int wakeword_melspec_stream(wakeword_melspec_state *state,
                            const float *pcm,
                            size_t n_samples,
                            float *out_columns,
                            size_t *out_n_columns);

/*
 * Diagnostic: return the centre frequency (Hz) of mel bin `mel_idx`.
 * Used by the unit test to map a tone frequency to its expected bin.
 */
float wakeword_mel_bin_center_hz(int mel_idx);

/* ---------------- sliding window (`wakeword_window.c`) ---------------- */

/*
 * Frame the streaming PCM into back-to-back `WW_FRAME_SAMPLES`-long
 * non-overlapping windows. The embedding stage upstream of this is
 * what owns the finer 10 ms mel cadence; this layer only governs the
 * 80 ms wake-classifier hop.
 *
 * The state buffers the residual when the caller's chunk does not land
 * on a frame boundary.
 */
typedef struct {
    float buffer[WW_FRAME_SAMPLES];
    size_t n_buffered;
    /* Monotonic count of frames emitted across the lifetime of this
     * state. The unit test reads it to verify timing. */
    uint64_t n_frames_emitted;
} wakeword_window_state;

void wakeword_window_state_init(wakeword_window_state *state);

/*
 * Push `n_samples` of PCM. Writes up to `max_frames` complete frames
 * (each `WW_FRAME_SAMPLES` floats) into `out_frames` and stores the
 * actual count in `*out_n_frames`. Any partial residue stays in
 * `state` for the next call.
 *
 * Returns 0 on success, -EINVAL on bad input.
 */
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
