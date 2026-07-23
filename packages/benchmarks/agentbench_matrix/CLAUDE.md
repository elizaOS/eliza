# AgentBench matrix adapter — Agent Guide

Code-agent comparison adapter that wraps the `elizaos_agentbench` runner so the
suite's matrix driver (`orchestrator/code_agent_matrix.py`) can run AgentBench
across multiple task agents (elizaos, opencode, …) and models, then normalize
each run into the common matrix result schema. It is **not a standalone
benchmark** and has no entry in `registry/commands.py` — the AgentBench
benchmark itself lives in `../agentbench/`; this package only adapts it for
head-to-head agent comparisons.

## Run

Normally the orchestrator imports `run_agentbench_matrix()` directly
(dynamic import as `benchmarks.agentbench_matrix.code_agent_matrix`) — you do
not invoke this package to run the matrix. For local debugging, the module has
a thin CLI:

```bash
# Direct — from the repo root (agentbench must be importable alongside benchmarks)
PYTHONPATH=packages:packages/benchmarks/agentbench \
    python3 -m benchmarks.agentbench_matrix.code_agent_matrix \
    --task-agent elizaos --model-provider cerebras --model gemma-4-31b \
    --output ./packages/benchmarks/benchmark_results/agentbench-matrix --json

# Restrict the environment slice (default: os,webshop,web_browsing,database,knowledge_graph)
... --envs os,database

# Cap tasks / capture trajectories / include edge-case fixtures
... --max-tasks 2 --trajectory-dir ./benchmark_results/traj --expand-scenarios
```

`--no-docker` is accepted only for CLI parity with the other matrix adapters;
it changes nothing here.

## Smoke test (no API keys)

```bash
# Mock runtime — no eliza server, no model calls; prints normalized JSON (repo root)
PYTHONPATH=packages:packages/benchmarks/agentbench \
    python3 -m benchmarks.agentbench_matrix.code_agent_matrix \
    --task-agent opencode --output /tmp/abm-smoke --max-tasks 1 --mock --json
```

## Test the adapter

```bash
pytest packages/benchmarks/agentbench_matrix/tests/ -v
```

The test drives the real CLI subprocess with `--mock --max-tasks 1` and asserts
the normalized JSON shape (`benchmark`, `adapter`, `summary.resolve_rate`, …).

## Layout

| Path | Role |
| --- | --- |
| `code_agent_matrix.py` | `run_agentbench_matrix()` public API + debug CLI (`main()`) |
| `__init__.py` | Package marker |
| `tests/test_code_agent_matrix.py` | CLI-subprocess integration smoke over the mock runtime |

## Notes

- Before starting the `ElizaServerManager`, `_configure_agent_env()` injects
  `BENCHMARK_TASK_AGENT`, `BENCHMARK_MODEL_PROVIDER`, `BENCHMARK_MODEL_NAME`,
  `ELIZA_AGENT_ORCHESTRATOR`, and per-provider model overrides
  (`OPENAI_LARGE_MODEL`, `GROQ_LARGE_MODEL`, `CEREBRAS_MODEL`, …) so every
  agent/model cell of the matrix runs against the requested model.
- Results are normalized to the matrix schema (`summary.total_instances` /
  `resolved` / `resolve_rate` / `score`) with the raw AgentBench
  `environment_reports` and `overall_metrics` carried alongside.
- Dataset versions are pinned (`agentbench-five-env-fixture-v1`, edge variant
  with `--expand-scenarios`) so matrix runs across agents stay comparable.
- Full background: [README.md](README.md); operator runbook:
  [`../docs/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`](../docs/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md).

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
