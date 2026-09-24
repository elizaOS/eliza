# elizaOS AgentBench

Faithful re-implementation of [AgentBench](https://github.com/THUDM/AgentBench) (THUDM, ICLR 2024) evaluating agents across eight environments: OS, Database, Knowledge Graph, Lateral Thinking Puzzle, Web Shopping, Card Game, Householding, and Web Browsing.

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
