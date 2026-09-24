# Vending-Bench

elizaOS reimplementation of Andon Labs' Vending-Bench ([arXiv 2502.15840](https://arxiv.org/abs/2502.15840), [leaderboard](https://andonlabs.com/evals/vending-bench)): evaluates LLM long-horizon coherence by simulating a vending-machine business (inventory ordering, pricing, cash management).

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
