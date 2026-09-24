# VisualWebBench Benchmark for ElizaOS

Seven-subtask multimodal web understanding and grounding benchmark, faithfully implementing [VisualWebBench](https://huggingface.co/datasets/visualwebbench/VisualWebBench) (Apache-2.0).

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
