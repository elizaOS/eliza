---
language: en
library_name: omnivoice
base_model: elizaos/eliza-1
license: other
license_name: research-only-her-derivative
tags:
- text-to-speech
- omnivoice
- eliza-1
- voice-clone
- research-only
---

# elizaos/eliza-1 — voice/omnivoice/presets/voice-preset-same.bin

OmniVoice frozen-conditioning **voice preset** for the `same` voice.

This artifact is a single ELZ2 v2 preset file published under the
consolidated [`elizaos/eliza-1`](https://huggingface.co/elizaos/eliza-1)
repo at `voice/omnivoice/presets/voice-preset-same.bin`. The OmniVoice
base LM (`omnivoice-base-*.gguf`) and tokenizer live alongside it under
`voice/omnivoice/`; this preset binds that base to the `same` reference clips +
VoiceDesign instruct string. At runtime the
`plugin-local-inference` FFI path loads the preset, encodes its reference
clips on demand (`eliza_inference_encode_reference`), and streams TTS
conditioned on the resulting `[K=8, ref_T]` token tensor.

## Files

| File                    | Purpose                                                      |
|-------------------------|--------------------------------------------------------------|
| `voice-preset.elz2`     | ELZ2 v2 preset — `refText` + `instruct` + provenance metadata |
| `voice-preset.json`     | Machine-readable preset metadata                              |
| `manifest-fragment.json`| Bundle install fragment (filename, sha256, install path)      |
| `eval.json`             | Preset-load gate report                                       |
| `README.md`             | This file                                                     |

## Preset details

- **Voice id:** `same`
- **Preset format:** ELZ2 v2 (`magic='ELZ1', version=2`)
- **Encoding mode:** metadata-only (`--skip-encode`).
  Reference tokens are encoded on demand by the FFI streaming path.
- **Reference clips:** 2 clips (`sam_001`, `sam_003`), total ~13.48 s
- **Reference seconds:** 13.48
- **Instruct string:** `young adult female, warm, soft, neutral us-american; conversational pacing`
- **Engine:** [`elizaos/eliza-1`](https://huggingface.co/elizaos/eliza-1/tree/main/voice/omnivoice) `voice/omnivoice/` (Qwen3-0.6B bidir + RVQ codec)
- **Preset size:** 716 bytes

## License & data provenance

This preset derives from the `sam` clips in
[`lalalune/ai_voices`](https://github.com/lalalune/ai_voices) (commit
`c6db5b5dc703e212664a17cf58114f5ecfddc853`). The upstream README states
the corpus is *for fun and research only* — there is no LICENSE file.
The `sam` voice itself is a derivative of the 2013 film *Her* (Warner
Bros).

This artifact is therefore distributed for **non-commercial research
and personal use only**. Do not redistribute the raw audio. The preset
(transcripts + an instruct string + a small JSON metadata blob) is
published here as a derivative work with attribution; commercial use
requires explicit rights clearance from the upstream rights holders.

The OmniVoice base LM under
[`elizaos/eliza-1`](https://huggingface.co/elizaos/eliza-1/tree/main/voice/omnivoice)
`voice/omnivoice/` is Apache-2.0; the research-only constraint here is on the **preset
binding**, not the upstream base.

## Runtime integration

1. Place `voice-preset.elz2` at
   `<bundle>/cache/voice-preset-same.bin` in any Eliza-1 per-tier bundle
   that ships OmniVoice (`eliza-1-0_6b`, `eliza-1-1_7b`, `eliza-1-0_8b`,
   `eliza-1-2b`, `eliza-1-4b`, `eliza-1-9b`, `eliza-1-27b`,
   `eliza-1-27b-256k`).
2. The runtime auto-discovers the preset and binds the `same` voice id.
   `POST /v1/audio/speech { voice: "same" }` and the FFI streaming path
   both honor the binding.
3. Optional: set `ELIZA_OMNIVOICE_DEFAULT_VOICE_ID=same` to make this
   the default voice on a bundle.

## Provenance

Built by `packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs`
with the flags:

```bash
node packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs \
    --voice same \
    --corpus packages/training/data/voice/same/ \
    --max-seconds 15 \
    --instruct "young adult female, warm, soft, neutral us-american; conversational pacing" \
    --skip-encode \
    --out release-staging/omnivoice-same-v01/voice-preset.elz2
```

Roundtrip-validated via `readVoicePresetFile`.
