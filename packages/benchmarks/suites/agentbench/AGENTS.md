# AgentBench — Agent Guide

Faithful re-implementation of [AgentBench](https://github.com/THUDM/AgentBench) (THUDM, ICLR 2024)
evaluating agents across eight environments: OS, Database, Knowledge Graph, Lateral Thinking Puzzle,
Web Shopping, Card Game, Householding, and Web Browsing. Registered in the suite registry as `agentbench`.

## Run

```bash
# Explicit fixture smoke — all eight adapters, no API keys
python -m elizaos_agentbench.cli run --data-mode fixture --runtime mock --output ./benchmark_results

# Direct — Eliza TS bridge runtime
python -m elizaos_agentbench.cli run --runtime bridge --output ./benchmark_results

# Specific environments only
python -m elizaos_agentbench.cli run --env database --env os --max-tasks 10

# Through the suite orchestrator
python -m suites.orchestrator run --benchmarks agentbench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Mock runtime runs without any external dependencies or API keys
python -m elizaos_agentbench.cli run --data-mode fixture --runtime mock --max-tasks 2 --output /tmp/ab-smoke

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
| `code_agent_matrix.py` | Matrix adapter: `run_agentbench_matrix()` drives AgentBench across task agents/models for the orchestrator matrix (`suites.agentbench.code_agent_matrix`) |
| `tests/test_code_agent_matrix.py` | Mock-mode CLI smoke test for the matrix adapter |

## Notes

- Results write to `./benchmark_results/` (or `--output` path): `agentbench-results.json`,
  `agentbench-report.md`, `agentbench-detailed.json`.
- Full `--env all` resolves the exact eight-environment corpus (1,264 test
  tasks; 13,904 with edge expansion) for count/validation, then exits
  unsupported before model calls until Avalon, ALFWorld, WebShop, and Mind2Web
  runtime parity exists. Explicit environment selections are diagnostic only.
- Scored by `_score_from_agentbench_json` in `registry/scores.py`.
- Compare against the public leaderboard: <https://llmbench.ai/agent/data>.
- KG environment needs `AGENTBENCH_KG_SPARQL_URL` for full SPARQL backend (Virtuoso).
- Card Game needs `AGENTBENCH_CARD_GAME_BIN`; Householding needs `alfworld-download` + `ALFWORLD_DATA`;
  Web Shopping needs `WEBSHOP_DATA_DIR`. All three are opt-in via `--env`.
- Full background: [README.md](README.md).

