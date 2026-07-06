# Orchestrator Lifecycle — Agent Guide

Multi-turn orchestration lifecycle benchmark: evaluates the elizaOS agent's
ability to handle clarification requests, status check-ins, scope changes,
pause/resume/cancel interruptions, and stakeholder summaries across scripted
scenario conversations. Registered in the suite as `orchestrator_lifecycle`.

## Run

```bash
# Direct (bridge mode — real elizaOS TS agent via bench server)
python -m benchmarks.orchestrator_lifecycle.cli \
  --provider openai --model gpt-4o \
  --output ./benchmark_results/orchestrator-lifecycle

# Through the suite orchestrator (manages provider/model, stores results)
python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle --provider <p> --model <m>
```

## Smoke test (no API keys, no TS server)

```bash
python -m benchmarks.orchestrator_lifecycle.cli \
  --mode simulate \
  --max-scenarios 3 \
  --output /tmp/olc-smoke
```

`--mode simulate` uses a deterministic simulator that emits typed lifecycle
events. It does not call any LLM or start the elizaOS bench server. Simulate
reports are smoke-marked (`scored: false`, `metrics.overall_score: null`) so
the suite registry refuses to publish them as benchmark results.

## Test the harness

```bash
# From the repo root (benchmarks package must be importable)
pytest packages/benchmarks/orchestrator_lifecycle/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | Argument parser + `main()` entrypoint |
| `runner.py` | `LifecycleRunner` — bridge and simulate execution modes |
| `evaluator.py` | Structural per-turn scoring of typed lifecycle events |
| `events.py` | Planner actions/params → typed lifecycle events |
| `dataset.py` | Loads scenario JSON files |
| `reporting.py` | Writes result JSON to output dir |
| `types.py` | `LifecycleConfig`, `ScenarioResult`, `LifecycleMetrics` |
| `scenarios/` | 12 JSON scenario definitions + schema |
| `tests/` | pytest suite (smoke + evaluator + dataset + schema) |

## Notes

- Results write to `./benchmark_results/orchestrator-lifecycle/` as
  `orchestrator-lifecycle-<timestamp>.json` (gitignored).
- Scored by `_score_from_orchestrator_lifecycle_json` in `registry/scores.py`.
- Bridge mode (default for LLM providers) forwards each turn to the elizaOS TS
  bench server (`packages/lifeops-bench/src/server.ts`) via
  `ElizaClient.send_message`. Set `ELIZA_BENCH_URL` to reuse a running server.
- Simulate mode is kept only for offline CI smoke-testing; it does not measure
  the real agent.
- Full scenario schema: [scenarios/README.md](scenarios/README.md).

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
