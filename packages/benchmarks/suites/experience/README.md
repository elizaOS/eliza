# Experience Benchmark

Evaluates the elizaOS experience service: retrieval quality (Precision@K, Recall@K, MRR, Hit Rate@K), reranking correctness, and end-to-end learn-then-apply cycle effectiveness.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

Build from this directory:

```bash
python -m pip wheel --no-deps . --wheel-dir dist
```

Test from this directory:

```bash
python -m pytest
```
