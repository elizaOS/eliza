#pragma once
// kokoro-engine.h: Kokoro-82M TTS engine on GGML.
//
// Free-standing ggml_backend graph (same approach as omnivoice's
// PipelineTTS + PipelineCodec). Owns its own weight context, its own
// graph buffer, and consumes a `kokoro-82m-v1_0.gguf` produced by
// `omnivoice/tools/convert_kokoro_to_gguf.py`.
//
// Architecture (mirrors the feasibility memo at
// plugins/plugin-local-inference/native/reports/porting/2026-05-14/
// kokoro-llama-cpp-feasibility.md §1):
//
//   phonemes [1, T_p]
//        |
//        v
//   text_encoder (ALBERT-style transformer, 4 layers, hidden=512)
//        |
//        v                              ref_s [1, 256]
//   prosody_predictor (LSTM + CNN) <----+
//        |
//        v (duration_i + F0_i + N_i)
//   length_regulator (gaussian-soft repeat-and-attend; T_p -> T_f)
//        |
//        v
//   iSTFTNet decoder (HiFi-GAN backbone -> mag+phase spec)
//        |
//        v
//   inverse-STFT (frozen CONV_TRANSPOSE_1D with cosine/sine basis)
//        |
//        v
//   audio [1, ~T_f * hop_length]
//
// No autoregressive sampler. No MaskGIT. No audio encoder. The graph is
// one big synchronous forward pass per utterance, chunked at the BERT
// encoder's 510-token cap (enforced in the runtime selector at
// plugins/plugin-local-inference/src/services/voice/kokoro/kokoro-runtime.ts:259).

#include "backend.h"
#include "gguf-weights.h"
#include "ov-error.h"
#include "weight-ctx.h"

#include "ggml-backend.h"
#include "ggml.h"

#include <cstdint>
#include <string>
#include <vector>

// Hard structural constants - these match `convert_kokoro_to_gguf.py`
// exactly. The loader cross-checks each one against the GGUF KV header
// and refuses to initialise on mismatch.
#define KOKORO_SAMPLE_RATE       24000
#define KOKORO_HOP_LENGTH        600
#define KOKORO_WIN_LENGTH        2400
#define KOKORO_N_FFT             2048
#define KOKORO_PHONEME_VOCAB     178
#define KOKORO_MAX_PHONEME       510
#define KOKORO_STYLE_DIM         256
#define KOKORO_TEXT_ENC_DEPTH    4
#define KOKORO_TEXT_ENC_HIDDEN   512
#define KOKORO_TEXT_ENC_HEADS    8
#define KOKORO_ISTFTNET_BLOCKS   4

// One iSTFTNet decoder block. Mirrors `DACBlock` in dac-decoder.h.
struct KokoroIstftBlock {
    // ConvTranspose1d upsample (rate from kokoro.istftnet.upsample_rates[i]).
    struct ggml_tensor * up_w;        // [k, OC, IC]
    struct ggml_tensor * up_b;        // [OC]
    int                  stride;
    int                  in_ch;
    int                  out_ch;
    int                  kernel;      // 2 * stride

    // 3 multi-receptive-field residual blocks per upsample stage.
    struct {
        struct ggml_tensor * conv_w[3];   // dilated convs (k=3, d in {1,3,5})
        struct ggml_tensor * conv_b[3];
        struct ggml_tensor * snake_alpha; // [1, C] f32
    } mrf[3];
};

// Per-block prosody predictor: 3 conv stacks for F0 and 3 for N (energy).
struct KokoroProsodyBlock {
    struct ggml_tensor * conv_w;
    struct ggml_tensor * conv_b;
    struct ggml_tensor * norm_w;
    struct ggml_tensor * norm_b;
};

// Single ALBERT-style transformer layer in the text encoder.
struct KokoroTextLayer {
    struct ggml_tensor * q_w, * q_b;
    struct ggml_tensor * k_w, * k_b;
    struct ggml_tensor * v_w, * v_b;
    struct ggml_tensor * o_w, * o_b;
    struct ggml_tensor * mlp_up_w, * mlp_up_b;
    struct ggml_tensor * mlp_down_w, * mlp_down_b;
    struct ggml_tensor * norm1_w, * norm1_b;
    struct ggml_tensor * norm2_w, * norm2_b;
};

// Top-level Kokoro engine handle. Lives behind an opaque `kokoro_context *`
// in the public ABI - this struct is only visible inside the .cpp.
struct KokoroEngine {
    // GGML backend pair (CPU + accelerator) and the weight context that
    // owns every model tensor. Same pattern as omnivoice's PipelineTTS.
    BackendPair  bp;
    WeightCtx    wctx;

    // Header values, validated against the constants above at load time.
    int sample_rate;
    int hop_length;
    int n_fft;
    int phoneme_vocab;
    int max_phoneme;
    int style_dim;

    // Text encoder.
    struct ggml_tensor * embed_w;       // [vocab, hidden]
    struct ggml_tensor * pos_embed_w;   // [max_phoneme, hidden]
    struct ggml_tensor * embed_norm_w;
    struct ggml_tensor * embed_norm_b;
    KokoroTextLayer      text_layers[KOKORO_TEXT_ENC_DEPTH];

    // Prosody predictor.
    struct ggml_tensor * dur_lstm_w_ih;
    struct ggml_tensor * dur_lstm_w_hh;
    struct ggml_tensor * dur_lstm_b_ih;
    struct ggml_tensor * dur_lstm_b_hh;
    struct ggml_tensor * dur_proj_w;
    struct ggml_tensor * dur_proj_b;
    KokoroProsodyBlock   f0_blocks[3];
    KokoroProsodyBlock   n_blocks[3];
    struct ggml_tensor * f0_proj_w;
    struct ggml_tensor * f0_proj_b;
    struct ggml_tensor * n_proj_w;
    struct ggml_tensor * n_proj_b;

    // iSTFTNet decoder.
    struct ggml_tensor * dec_input_proj_w;
    struct ggml_tensor * dec_input_proj_b;
    KokoroIstftBlock     dec_blocks[KOKORO_ISTFTNET_BLOCKS];
    struct ggml_tensor * dec_output_w;       // [k, 2*(n_fft/2+1), C_last]
    struct ggml_tensor * dec_output_b;

    // Frozen inverse-STFT basis (precomputed in the converter).
    struct ggml_tensor * istft_basis;        // [n_fft, 2*(n_fft/2+1)]
    struct ggml_tensor * istft_window;       // [n_fft]
};

// ---------------------------------------------------------------------------
// Public engine API (internal to omnivoice-core; the user-facing surface is
// `eliza_inference_tts_synthesize{,_stream}` in `ffi.h`).
// ---------------------------------------------------------------------------

// Load a Kokoro GGUF from disk and populate `eng`. Returns false on any
// failure and writes a diagnostic via `ov_set_error` (so the FFI layer can
// surface it via `eliza_inference_free_string`'s error channel). The
// caller owns `eng->bp` and must call `kokoro_engine_free` to release it.
bool kokoro_engine_load(KokoroEngine * eng, const char * gguf_path);

// Free every tensor + backend resource owned by `eng`. Safe on a
// zero-initialised struct (no double-free, no NULL deref).
void kokoro_engine_free(KokoroEngine * eng);

// Synthesis input. PCM output is mono 24 kHz float at the model's native
// sample rate; the caller owns the buffer.
struct KokoroSynthInput {
    const int32_t * phoneme_ids;    // length [n_phonemes], in [0, vocab)
    int             n_phonemes;     // <= KOKORO_MAX_PHONEME
    const float *   style;          // [style_dim] - one row of the voice .bin
    float           speed;          // 1.0 default; 0.5 = half-speed
};

struct KokoroSynthOutput {
    float * samples;                // malloc-allocated, caller frees
    int     n_samples;
};

// Run the full Kokoro forward pass. Returns false + ov_set_error on
// failure; on success populates `out` and the caller owns `out->samples`.
bool kokoro_engine_synthesize(KokoroEngine * eng,
                              const KokoroSynthInput * in,
                              KokoroSynthOutput * out);

// Streaming variant: same input contract as the buffered call, but emits
// chunks of `chunk_samples` PCM samples through `cb`. Returning false
// from the callback aborts the synthesis (treated as user cancellation).
typedef bool (*kokoro_chunk_cb)(const float * samples, int n_samples, void * user_data);

bool kokoro_engine_synthesize_stream(KokoroEngine * eng,
                                     const KokoroSynthInput * in,
                                     int                       chunk_samples,
                                     kokoro_chunk_cb           cb,
                                     void *                    user_data);
