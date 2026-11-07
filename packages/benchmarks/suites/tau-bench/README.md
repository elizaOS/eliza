# ElizaOS tau-bench Benchmark

Vendored implementation of Sierra's [tau-bench](https://github.com/sierra-research/tau-bench) (Yao et al., 2024): Tool-Agent-User Interaction benchmark across retail (115 tasks) and airline (50 tasks) domains, with pass^k scoring and an LLM judge.

## Development

Install the shared Python support package from the repository root with `python -m pip install ./packages/benchmarks` before installing this suite.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
