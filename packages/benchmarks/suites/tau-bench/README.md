# ElizaOS tau-bench Benchmark

Vendored implementation of Sierra's [tau-bench](https://github.com/sierra-research/tau-bench) (Yao et al., 2024): Tool-Agent-User Interaction benchmark across retail (115 tasks) and airline (50 tasks) domains, with pass^k scoring and an LLM judge.

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
