# elizaos/eliza-1-voice-turn

**Eliza-1 Voice Turn Detector** — LiveKit turn-detector + turnsense fallback for end-of-turn detection.

## Model Card

| Field | Value |
|-------|-------|
| Architecture (en) | SmolLM2-135M distilled (livekit/turn-detector v1.2.2-en) |
| Architecture (intl) | Pruned Qwen2.5-0.5B, 14 languages (livekit/turn-detector v0.4.1-intl) |
| Quantization | ONNX INT8 |
| Runtime | onnxruntime-node |
| License | Apache-2.0 |

## Parent Models

- EN: [livekit/turn-detector](https://huggingface.co/livekit/turn-detector) v1.2.2-en
- INTL: livekit/turn-detector v0.4.1-intl (pruned Qwen2.5-0.5B, 14 langs)

## Eval Baselines

| Benchmark | Score | Variant |
|-----------|-------|---------|
| LiveKit eval F1 | 0.84 | EN |
| LiveKit eval F1 | 0.79 | INTL (multilingual) |

## Intended Use

End-of-turn detection for the Eliza-1 voice pipeline. The EN variant runs on small text tiers (≤1.7B); the INTL variant runs on larger tiers (≥4B) for multilingual support. The turnsense fallback activates in battery-saver or offline scenarios.

## Files

| File | Role | Size |
|------|------|------|
| `turn-detector-en-int8.onnx` | EN variant (SmolLM2-135M, INT8) | ~62.6 MB |
| `turn-detector-intl-int8.onnx` | INTL variant (Qwen2.5-0.5B, INT8) | ~377.7 MB |
| `turnsense-fallback-int8.onnx` | Energy+pitch heuristic fallback | ~7.6 MB |
| `manifest.json` | Machine-readable metadata | — |

## Integration

Consumed by `plugin-local-inference` `VoiceTurnDetector` (W3-1 implementation). Tier routing:
- `0_8b`, `2b`: `turn-detector-en-int8.onnx`
- `4b` and above: `turn-detector-intl-int8.onnx`
- Fallback: `turnsense-fallback-int8.onnx`

## License

Apache-2.0.
