# Experience Benchmark

Evaluates the elizaOS experience service: retrieval quality (Precision@K, Recall@K, MRR, Hit Rate@K), reranking correctness, and end-to-end learn-then-apply cycle effectiveness.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
