# AgentBench — Agent Guide

Faithful re-implementation of [AgentBench](https://github.com/THUDM/AgentBench) (THUDM, ICLR 2024)
evaluating agents across eight environments: OS, Database, Knowledge Graph, Lateral Thinking Puzzle,
Web Shopping, Card Game, Householding, and Web Browsing. Registered in the suite registry as `agentbench`.

## Run

```bash
# Direct, from this directory — mock runtime (no API keys)
python -m elizaos_agentbench.cli run --output ./benchmark_results

# Direct — Eliza TS bridge runtime
python -m elizaos_agentbench.cli run --runtime bridge --output ./benchmark_results

# Specific environments only
python -m elizaos_agentbench.cli run --env database --env os --max-tasks 10

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks agentbench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Mock runtime runs without any external dependencies or API keys
python -m elizaos_agentbench.cli run --runtime mock --max-tasks 2 --output /tmp/ab-smoke

# Dry-run preflight (allows zero-task environments)
python -m elizaos_agentbench.cli run --dry-run --allow-empty --output /tmp/ab-dry
```

## Test the harness

```bash
pip install -e .[dev]
pytest elizaos_agentbench/tests/ -v

# Targeted suites
pytest elizaos_agentbench/tests/test_upstream_loader.py -v   # data loader smoke
pytest elizaos_agentbench/tests/test_upstream_scoring.py -v  # scoring contracts
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_agentbench/cli.py` | `agentbench` CLI entrypoint (`run`, `list`, `data`) |
| `run_benchmark.py` | Standalone script entrypoint (same flags as CLI) |
| `elizaos_agentbench/runner.py` | `AgentBenchRunner`: dispatches tasks to adapters |
| `elizaos_agentbench/types.py` | `AgentBenchConfig`, `BenchmarkSplit`, DTOs |
| `elizaos_agentbench/upstream_loader.py` | Loaders for vendored upstream data splits |
| `elizaos_agentbench/adapters/` | Per-environment adapters (db, os, kg, lt, ws, m2w, …) |
| `elizaos_agentbench/mock_runtime.py` | `SmartMockRuntime` for offline/CI testing |
| `elizaos_agentbench/tests/` | pytest suite (65+ tests) |
| `upstream/` | Vendored THUDM/AgentBench data (Apache 2.0) |

## Notes

- Results write to `./benchmark_results/` (or `--output` path): `agentbench-results.json`,
  `agentbench-report.md`, `agentbench-detailed.json`.
- Scored by `_score_from_agentbench_json` in `registry/scores.py`.
- Compare against the public leaderboard: <https://llmbench.ai/agent/data>.
- KG environment needs `AGENTBENCH_KG_SPARQL_URL` for full SPARQL backend (Virtuoso).
- Card Game needs `AGENTBENCH_CARD_GAME_BIN`; Householding needs `alfworld-download` + `ALFWORLD_DATA`;
  Web Shopping needs `WEBSHOP_DATA_DIR`. All three are opt-in via `--env`.
- Full background: [README.md](README.md).
