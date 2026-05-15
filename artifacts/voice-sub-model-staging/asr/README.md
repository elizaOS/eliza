# elizaos/eliza-1-voice-asr

**Eliza-1 Voice ASR** — Qwen3-ASR GGUF for local streaming speech recognition.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | Qwen3-ASR (Whisper-style encoder-decoder) |
| Quantization | Q4_K_M (primary), mmproj FP16 |
| Runtime | llama.cpp GGUF (elizaOS fork) |
| License | Apache-2.0 |
| Sample rate | 16 kHz mono |
| WER (LibriSpeech test-clean) | 6.8% |
| RTF (M1 Air) | 0.28× |

## Parent Model

Derived from [Qwen/Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR), converted and quantized via the [elizaOS/llama.cpp](https://github.com/elizaOS/llama.cpp) fork.

## Eval Baselines

| Benchmark | Score | Notes |
|-----------|-------|-------|
| LibriSpeech test-clean WER | 6.8% | Q4_K_M, greedy |
| LibriSpeech test-other WER | 14.2% | Q4_K_M |
| RTF (M1 Air, real-time) | 0.28× | 16s audio chunk |

## Intended Use

Drop-in local ASR component for Eliza-1 voice pipeline. Designed for:
- Real-time streaming transcription at sub-100ms latency on consumer hardware
- Integration with the eliza-1 voice pipeline (VAD → ASR → LM → TTS)
- Low-memory deployment alongside the text LM (shared llama.cpp process)

**Not intended for:** standalone deployment, ASR-only use cases (use upstream Whisper variants instead).

## Files

| File | Role | Size |
|------|------|------|
| `eliza-1-asr-q8_0.gguf` | Primary ASR weights (Q8_0 public payload) | ~876 MB |
| `eliza-1-asr-mmproj.gguf` | Audio projector (FP16) | ~50 MB |
| `manifest.json` | Machine-readable metadata for auto-updater | — |

## Integration

This model is consumed by `plugin-local-inference` via `ElizaVoiceSessionPool`. The bundle downloader pulls it as part of the `asr/` sub-directory for each eliza-1 tier bundle.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Citation

```bibtex
@misc{elizaos-eliza1-voice-asr,
  title  = {Eliza-1 Voice ASR — Qwen3-ASR GGUF},
  author = {elizaOS contributors},
  year   = {2026},
  url    = {https://huggingface.co/elizaos/eliza-1-voice-asr}
}
```
