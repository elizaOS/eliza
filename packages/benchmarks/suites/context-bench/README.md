# ElizaOS Context Benchmark

Needle-in-a-haystack (NIAH), semantic NIAH, multi-hop context retrieval, and conversation-compaction drift benchmark.

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
