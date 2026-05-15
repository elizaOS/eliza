# elizaos/eliza-1-voice-omnivoice

**Eliza-1 Voice OmniVoice** — OmniVoice frozen-conditioning TTS with sam preset. Primary production TTS for Eliza-1.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | OmniVoice (Qwen3-0.6B bidir LM + MaskGIT + DAC vocoder) |
| Quantization | Q4_K_M (small tiers), Q8_0 (large tiers) |
| Runtime | llama.cpp GGUF (elizaOS fork, W3-3 integration) |
| License | Apache-2.0 |
| Sam preset | ELZ2 v2 (frozen-conditioning, pre-encoded reference tokens) |
| RTF | 3.5–5× realtime (reference token overhead) |

## Why OmniVoice is the Primary Sam TTS

The W3-11 Kokoro sam fine-tune regressed on all quality metrics (WER +53%, SpkSim -0.21, UTMOS -34 vs baseline). The decision from W3-11 post-mortem: use OmniVoice frozen-conditioning as the primary sam voice while the Kokoro fine-tune is retried with a larger corpus (≥3h target).

## Quantization Notes

- PolarQuant / TurboQuant applies to the Qwen3-0.6B bidirectional LM weights.
- **V-cache PolarQuant does NOT apply** — MaskGIT has no KV cache between steps.
- QJL-K is deferred (I8 territory).

## FFI ABI

ABI v4 exports:
- `eliza_inference_encode_reference` — encode reference audio into preset tokens
- `eliza_inference_free_tokens` — release token buffer

## Presets

The sam preset (`presets/voice-preset-sam.bin`) is an ELZ2 v2 preset containing pre-encoded `[K=8, ref_T]` reference-audio tokens. This eliminates per-utterance encode cost at runtime (`ov_encode_reference` is only needed to create new presets, not to use them).

## Files

| File | Role | Size |
|------|------|------|
| `omnivoice-base-q4_k_m.gguf` | Primary weights Q4_K_M (small tiers) | ~370 MB |
| `omnivoice-tokenizer-q4_k_m.gguf` | Tokenizer Q4_K_M | ~49 MB |
| `omnivoice-base-q8_0.gguf` | High-quality Q8_0 (large tiers) | ~591 MB |
| `presets/voice-preset-sam.bin` | Sam ELZ2 v2 preset | ~8 KB |
| `manifest.json` | Machine-readable metadata | — |

## Tier Routing

| Tier | Weights | Quant |
|------|---------|-------|
| 0_8b, 2b, 4b | `omnivoice-base-q4_k_m.gguf` | Q4_K_M |
| 9b, 27b, 27b-256k | `omnivoice-base-q8_0.gguf` | Q8_0 |

## License

Apache-2.0.
