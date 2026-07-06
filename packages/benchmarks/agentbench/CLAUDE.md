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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
