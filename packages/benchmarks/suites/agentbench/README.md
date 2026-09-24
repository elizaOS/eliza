# elizaOS AgentBench

Adapters and pinned task loaders for [AgentBench](https://github.com/THUDM/AgentBench) (THUDM, ICLR 2024) with task data for eight environments: OS, Database, Knowledge Graph, Lateral Thinking Puzzle, Web Shopping, Card Game, Householding, and Web Browsing.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

Fetch and verify the pinned upstream data explicitly before dataset tests:

```bash
python -c 'from elizaos_agentbench.upstream_loader import fetch_upstream_data; fetch_upstream_data()'
```

Dataset coverage does not imply executable environment coverage. Card Game,
Householding, Web Browsing, and Web Shopping require external bridges; unavailable
environments must remain unsupported and cannot count as successful agent runs.
