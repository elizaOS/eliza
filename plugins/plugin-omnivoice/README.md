# @elizaos/plugin-omnivoice

Local text-to-speech for [elizaOS](https://github.com/elizaos/eliza) agents via [omnivoice.cpp](https://github.com/k2-fsa/omnivoice.cpp) — voice cloning, voice design, emotion-aware synthesis, and singing, running on CPU, Metal, CUDA, or Vulkan.

## What it does

This plugin gives an Eliza agent fully offline TTS with no cloud round-trip. It registers `ModelType.TEXT_TO_SPEECH` backed by the `libomnivoice` shared library through Bun's native FFI. Three synthesis modes are supported:

- **Voice design** — describe a voice by gender, age, pitch, style, volume, and emotion. The plugin converts those attributes into an OmniVoice instruct string automatically.
- **Voice cloning** — provide a reference WAV at 24 kHz mono plus its transcript. The codec tokenizes the reference audio and the model reproduces the voice. Cloning is exposed by the synthesis core (`runSynthesis` with `reference` in `OmnivoiceSynthesizeOptions`), not by the `ModelType.TEXT_TO_SPEECH` handler input — that handler forwards only `text`, `lang`, `instruct`, `design`, and `singing`.
- **Singing** — uses a separate singing model GGUF loaded from `OMNIVOICE_SINGING_MODEL_PATH`. Pass `singing: true` in the TTS input to route to this path.

Output is always a 16-bit PCM WAV buffer, compatible with the same consumers as plugin-elevenlabs.

omnivoice.cpp has no ASR head. For speech-to-text pair this plugin with plugin-elevenlabs, plugin-deepgram, or a Whisper-backed plugin.

## Requirements

- **Bun runtime.** The FFI layer uses `bun:ffi`; Node.js without Bun is not supported.
- **libomnivoice shared library.** Build from the repo root:
  ```bash
  node plugins/plugin-local-inference/native/build-omnivoice.mjs
  ```
  This produces `libomnivoice.{so,dylib,dll}` in `plugins/plugin-local-inference/native/omnivoice.cpp/build/`. Point `OMNIVOICE_LIB_PATH` at that file.
- **Model GGUFs.** Download from [HuggingFace Serveurperso/OmniVoice-GGUF](https://huggingface.co/Serveurperso/OmniVoice-GGUF). You need the base language model GGUF and the tokenizer/codec GGUF separately.

## Configuration

| Environment variable | Required | Default | Description |
|---|---|---|---|
| `OMNIVOICE_MODEL_PATH` | Yes | — | Path to the base language model GGUF |
| `OMNIVOICE_CODEC_PATH` | Yes | — | Path to the tokenizer/codec GGUF |
| `OMNIVOICE_LIB_PATH` | No | auto-search | Absolute path to `libomnivoice.{so,dylib,dll}` |
| `OMNIVOICE_SINGING_MODEL_PATH` | No | — | Path to the singing model GGUF (required for `singing: true`) |
| `OMNIVOICE_LANG` | No | `English` | Default language hint; `""` = auto-detect |
| `OMNIVOICE_INSTRUCT` | No | — | Default voice-design instruct string (e.g. `"female young adult moderate happy"`) |
| `OMNIVOICE_USE_FA` | No | `true` | Enable flash attention for GPU backends |
| `OMNIVOICE_AUTO_DETECT` | No | `true` | Set to `0` to disable automatic GGUF discovery |

All variables are also readable via `runtime.getSetting()` in agent configuration.

## Auto-enable

The plugin activates automatically when any of these conditions are true:

- `OMNIVOICE_MODEL_PATH` and `OMNIVOICE_CODEC_PATH` are both set.
- Agent config has `features.localTts: true`.
- Agent config has `features.tts: { provider: "omnivoice" }`.
- GGUF files are discovered under `<stateDir>/models/omnivoice/speech/` (where `stateDir` defaults to `~/.eliza`).

Set `OMNIVOICE_AUTO_DETECT=0` to prevent filesystem discovery.

## Usage in an Eliza agent

```typescript
import omnivoicePlugin from "@elizaos/plugin-omnivoice";

// In your agent character or runtime config:
plugins: [omnivoicePlugin]
```

```typescript
// Plain TTS
const wav = await runtime.useModel(ModelType.TEXT_TO_SPEECH, "Hello, world!");

// Voice design
const wav = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
  text: "Hello, world!",
  design: { gender: "female", age: "young", emotion: "happy" },
});

// Singing
const wav = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
  text: "La la la",
  singing: true,
});
```

Output `wav` is a Node.js `Buffer` containing a 16-bit PCM WAV file.

Voice cloning is not reachable through the model handler. Drive the synthesis core directly:

```typescript
import {
  OmnivoiceContext,
  runSynthesis,
  pcmFloatToWavBuffer,
} from "@elizaos/plugin-omnivoice";

const ctx = await OmnivoiceContext.open({ modelPath, codecPath });
const result = await runSynthesis(ctx, {
  text: "Hello, world!",
  reference: { audio24k: referenceSamples, text: "reference transcript" },
});
const wav = pcmFloatToWavBuffer(result.samples, result.sampleRate, result.channels);
```

## Supported emotions

`neutral`, `happy`, `sad`, `angry`, `surprised`, `fearful`, `disgusted`. Common synonyms (e.g. `calm`, `joyful`, `mad`, `scared`) are coerced to the nearest canonical value.

## Browser

The plugin exports a browser-safe unavailable entry. Any TTS call in a browser context throws `OmnivoiceNotInstalled`. Load the plugin only in Node/Bun agents.
