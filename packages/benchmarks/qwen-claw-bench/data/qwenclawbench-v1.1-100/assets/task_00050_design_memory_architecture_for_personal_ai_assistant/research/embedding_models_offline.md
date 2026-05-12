# Offline Embedding Models for Semantic Search

## Date: 2024-01-17
## Purpose: Evaluate embedding models suitable for local-first, offline semantic search
## Constraint: Must run on CPU without GPU; model must be downloadable and self-contained

---

## Critical Requirements for Our Use Case

For a local-first personal AI assistant, the embedding model must satisfy:

1. **Runs entirely offline** — no API calls to OpenAI, Cohere, etc.
2. **Reasonable CPU inference speed** — must embed a query in < 200ms on a modern laptop CPU
3. **Small model footprint** — ideally under 300MB to stay within our storage budget
4. **Good quality** — competitive scores on MTEB (Massive Text Embedding Benchmark)
5. **ONNX compatible** — we plan to use ONNX Runtime for cross-platform CPU inference

---

## Model Comparison

### 1. all-MiniLM-L6-v2 (Sentence Transformers)

| Property | Value |
|---|---|
| Model Size | 80 MB |
| Embedding Dimensions | 384 |
| Max Sequence Length | 256 tokens |
| Tokens/Second (CPU) | ~2,800 |
| MTEB Average Score | 56.26 |
| ONNX Support | Yes (official export available) |
| License | Apache 2.0 |

**Notes:** The workhorse of lightweight embedding. Excellent speed-to-quality ratio. The 256-token limit means longer documents need chunking, but for our memory entries (typically 100-500 words) this is usually sufficient. Most widely deployed offline embedding model.

### 2. nomic-embed-text-v1.5 (Nomic AI)

| Property | Value |
|---|---|
| Model Size | 274 MB |
| Embedding Dimensions | 768 |
| Max Sequence Length | 8,192 tokens |
| Tokens/Second (CPU) | ~850 |
| MTEB Average Score | 62.28 |
| ONNX Support | Yes |
| License | Apache 2.0 |

**Notes:** Significantly higher quality than MiniLM, with a much longer context window (8K tokens). However, 3x larger and 3x slower on CPU. The 768-dim embeddings also require more storage for the vector index. Best choice if quality is paramount and the user has a faster CPU.

### 3. BGE-small-en-v1.5 (BAAI)

| Property | Value |
|---|---|
| Model Size | 130 MB |
| Embedding Dimensions | 384 |
| Max Sequence Length | 512 tokens |
| Tokens/Second (CPU) | ~2,100 |
| MTEB Average Score | 59.25 |
| ONNX Support | Yes |
| License | MIT |

**Notes:** Good middle ground between MiniLM and larger models. Higher quality than MiniLM with only moderate size increase. The 512-token context window is more comfortable for our use case. Developed by Beijing Academy of AI (BAAI) with strong benchmark performance.

### 4. GTE-small (Alibaba DAMO)

| Property | Value |
|---|---|
| Model Size | 67 MB |
| Embedding Dimensions | 384 |
| Max Sequence Length | 512 tokens |
| Tokens/Second (CPU) | ~3,100 |
| MTEB Average Score | 57.82 |
| ONNX Support | Yes |
| License | MIT |

**Notes:** Smallest and fastest model evaluated. Surprisingly competitive quality for its size. Best choice for extremely resource-constrained environments. The 67MB footprint means it can be bundled with the application without significant bloat.

---

## Inference Runtime: ONNX Runtime

We recommend using **ONNX Runtime** (onnxruntime package) for inference:

- Cross-platform: works on Windows, macOS, Linux
- CPU-optimized with AVX2/AVX512 support
- Typically 2-3x faster than PyTorch for CPU inference
- No dependency on PyTorch or TensorFlow at runtime
- Models can be exported to ONNX format using `optimum` library

### Installation
```bash
pip install onnxruntime
# For optimized CPU inference:
pip install onnxruntime-extensions
```

### Typical Inference Pipeline
```python
import onnxruntime as ort
from tokenizers import Tokenizer

# Load model and tokenizer
session = ort.InferenceSession("model.onnx")
tokenizer = Tokenizer.from_file("tokenizer.json")

# Encode text
encoded = tokenizer.encode("query text here")
inputs = {"input_ids": [encoded.ids], "attention_mask": [encoded.attention_mask]}

# Get embedding
outputs = session.run(None, inputs)
embedding = outputs[0][0]  # Shape: (384,) or (768,)
```

---

## Storage Estimates for Embedding Vectors

Assuming 384-dimensional float32 embeddings:
- Per entry: 384 × 4 bytes = **1,536 bytes ≈ 1.5 KB**
- 10,000 entries: ~15 MB
- 100,000 entries (2 years of heavy use): ~150 MB

Assuming 768-dimensional float32 embeddings:
- Per entry: 768 × 4 bytes = **3,072 bytes ≈ 3 KB**
- 100,000 entries: ~300 MB

**Recommendation:** Use 384-dim models to keep vector storage manageable within the 10GB budget.

---

## Recommendation

For our local-first memory system, we recommend **all-MiniLM-L6-v2** as the default model with **GTE-small** as a lightweight alternative:

- MiniLM: best balance of speed, size, and ecosystem maturity
- GTE-small: best for users who prioritize minimal storage footprint
- BGE-small: upgrade path for users who want better quality
- nomic-embed-text: future option when CPU speeds improve or for GPU-equipped machines

All models should be distributed as ONNX files bundled with the application.
