# elizaos/eliza-1-voice-embedding

**Eliza-1 Voice Embedding** — Qwen3-Embedding GGUF for voice profile text features.

## Model Card

| Field | Value |
|-------|-------|
| Architecture | Qwen3-Embedding (gte-base derivative) |
| Vocab | BPE (Qwen3 tokenizer) |
| Embedding dim | 1024 |
| Max sequence length | 8192 tokens |
| Quantization | Q8_0 (Q4_K_M planned) |
| Runtime | llama.cpp GGUF (elizaOS fork) |
| License | Apache-2.0 |
| MTEB average | 64.1% |

## Parent Model

Derived from [Qwen/Qwen3-Embedding](https://huggingface.co/Qwen/Qwen3-Embedding), quantized via the elizaOS/llama.cpp fork.

## Eval Baselines

| Benchmark | Score |
|-----------|-------|
| MTEB average (EN) | 64.1% |

## Intended Use

Text-side embedding for the Eliza-1 voice pipeline, specifically:
- `InMemoryVoiceProfileStore` — query-text speaker features (alongside acoustic embeddings from the speaker encoder)
- Voice profile search and matching in multi-speaker sessions

**Tier availability:** 4b and above only. Small tiers (0_8b, 2b) lack capacity for a separate embedding model and use approximate matching without text embeddings.

## Files

| File | Role | Size |
|------|------|------|
| `eliza-1-embedding-q8_0.gguf` | Primary (Q8_0) | ~610 MB |
| `manifest.json` | Machine-readable metadata | — |

A `Q4_K_M` variant (~330 MB) is planned for follow-up; the runtime currently consumes the Q8_0 file via the embedding sidecar on the 4b+ tiers.

## Usage

```python
from llama_cpp import Llama

llm = Llama(model_path="eliza-1-embedding-q8_0.gguf", embedding=True, n_ctx=512)
vec = llm.embed("hello world")
# len(vec[0]) == 1024
```

## Coordination Note

F5 (vision mmproj) may upload additional files to the parent `elizaos/eliza-1` repo rather than this sub-model repo. The embedding sub-model repo (`elizaos/eliza-1-voice-embedding`) holds the standalone embedding GGUF only. The main bundle repo (`elizaos/eliza-1`) holds the per-tier bundled version under `bundles/<tier>/embedding/`.

## License

Apache-2.0.
