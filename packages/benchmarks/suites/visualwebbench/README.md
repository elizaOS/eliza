# VisualWebBench Benchmark for ElizaOS

Seven-subtask multimodal web understanding and grounding benchmark, faithfully implementing [VisualWebBench](https://huggingface.co/datasets/visualwebbench/VisualWebBench) (Apache-2.0).

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/visualwebbench/tests
```
