# plugin-omnivoice — research notes (Phase E1)

## Models

### ModelsLab/omnivoice-singing
Source: https://huggingface.co/ModelsLab/omnivoice-singing

- 0.6B params (Qwen3-0.6B LM + HiggsAudioV2 tokenizer)
- License: Apache 2.0 (model weights). Several training datasets are
  CC BY-NC-* / CC BY-NC-SA — non-commercial restrictions apply to any
  derived voice clones using those data, **not** to the model weights
  themselves. Treat singing voices created from RAVDESS / GTSinger /
  Expresso prompts as non-commercial unless the user provides their
  own data.
- Sample rate: 24 kHz mono (matches base omnivoice → no resampler needed
  in our FFI binding).
- Drop-in for `k2-fsa/OmniVoice`. Same forward path, same tokenizer.
- The HF repo currently ships safetensors (I64, F32). For
  omnivoice.cpp we will need GGUF conversion via the
  `convert.py` + `quantize.sh` flow already vendored under
  `packages/inference/omnivoice.cpp/`. **Open task:** publish the
  converted singing GGUF to a Milady HF mirror so end users do not
  need a `pip install transformers`-class toolchain at install time.

### Serveurperso/OmniVoice-GGUF (canonical base GGUF source)
Source: https://huggingface.co/Serveurperso/OmniVoice-GGUF

Two files must always load together:

| File pair | Base size | Tokenizer size | Notes |
| --- | --- | --- | --- |
| Q8_0 (recommended) | 656 MB | 289 MB | Default for plugin |
| Q4_K_M | 407 MB | 252 MB | Lowest VRAM, slight quality loss |
| BF16 | 1.23 GB | 373 MB | Source-faithful |
| F32 | 2.46 GB | 734 MB | Reference / debug only |

CLI pairing matches what the omnivoice-tts binary expects:

```
omnivoice-tts \
  --model models/omnivoice-base-Q8_0.gguf \
  --codec models/omnivoice-tokenizer-Q8_0.gguf
```

The plugin uses the same pairing — `OMNIVOICE_MODEL_PATH` and
`OMNIVOICE_CODEC_PATH` env vars in the agent map directly to
`ov_init_params.model_path` / `.codec_path`.

## Emotion-aware TTS landscape (2026 snapshot)

omnivoice's `instruct` parameter (e.g. `"female young adult moderate
happy"`) accepts an **emotion** keyword natively — this is the entire
"emotion-aware TTS" feature. We expose it through the elizaOS
`USE_SKILL` planner via the `Emotion` taxonomy in
`packages/ui/src/voice/emotion.ts` and wire it into the C `instruct`
string in `src/synth.ts`.

Adjacent open-source candidates worth tracking (not implemented in
this phase, listed for follow-up):

- **OpenVoice v2** (MyShot AI, MIT) — voice cloning + emotion
  conditioning via per-emotion reference WAVs. Higher VRAM, no GGML
  port. Reasonable HTTP-side fallback.
- **F5-TTS** (Apache 2.0) — diffusion-style TTS with emotion-tagged
  prompts. CPU-friendly via ONNX. Considered for plugin-elevenlabs's
  ASR-side emotion enrichment.
- **Parler-TTS** (Apache 2.0) — natural-language style prompts
  including emotion (`"a happy young woman"`). Easier prompt surface
  but lower voice consistency than omnivoice.

## Emotion-aware ASR landscape (2026 snapshot)

This is genuinely thin and a real gap.

- omnivoice ships **`omnivoice-codec`** which encodes WAV → RVQ
  tokens. This is **not** transcription — it produces audio tokens
  for the LM to consume, not text. We surface
  `ModelType.TRANSCRIPTION` as a stub that throws a clear
  `OmnivoiceTranscriptionNotSupported` error pointing the user at
  Whisper / plugin-elevenlabs / plugin-deepgram.
- **SenseVoice** (Alibaba, Apache 2.0) — multilingual ASR with
  emotion + audio-event tags. ONNX path runs on CPU. Best pairing
  for an "ASR with emotion" companion plugin (out of scope for this
  PR; track as `plugin-sensevoice`).
- **emotion2vec / emotion2vec_plus** (CC BY-NC) — pure-emotion
  classifier head sitting on top of any ASR. Could attach to the
  existing whisper / elevenlabs ASR output as a sidecar enricher —
  documented as follow-up.

## elizaOS integration choices

- **Plugin shape:** mirror `plugin-edge-tts` (Node-only, browser stub,
  `Buffer` return from TTS handler). Do NOT mirror `plugin-elevenlabs`
  for ASR — omnivoice has no transcription head.
- **Native binding:** `bun:ffi` lazy-load, identical pattern to
  `plugin-aosp-local-inference`. Failure mode is a typed
  `OmnivoiceNotInstalled` error with a `cmake` invocation in the
  `.message` field.
- **Audio container:** omnivoice returns `float * samples` PCM at
  24 kHz mono. The plugin wraps these in a 44-byte WAV header so
  the existing `plugin-elevenlabs` consumer code (which expects
  `audio/wav` or `audio/mpeg` Buffers) is drop-in.
- **Singing model:** loaded as a separate `OmnivoiceContext`
  instance with the singing GGUF passed as `model_path`. Selected
  via `params.singing === true` — see `src/singing.ts`.

## Open follow-ups (ranked by impact)

1. Publish converted singing GGUF to a Milady HF mirror.
2. Add streaming chunk pipe from `ov_audio_chunk_cb` to the
   browser `MediaSource` so first-byte latency falls below 300 ms.
3. Build `plugin-sensevoice` for emotion-aware ASR.
4. Land the omnivoice → llama.cpp fork merge plan
   (`packages/inference/llama.cpp-omnivoice-merge/`).
5. Wire emotion taxonomy into `useVoiceChat` (read-only this phase).
