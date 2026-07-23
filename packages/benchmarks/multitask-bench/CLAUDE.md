# MultitaskBench — Agent Guide

Concurrency-interference benchmark: one long-lived agent drives N interleaved
LifeOps tasks (N=1/5/10) and the headline metric is the per-task score delta at
N versus the N=1 baseline over identical `(scenario, seed)` pairs. A thin
scheduler over [`lifeops-bench`](../lifeops-bench) — each task is one LifeOps
STATIC scenario through `LifeOpsBenchRunner.run_one` against the frozen
10-scenario sample. Registered in the suite registry as `multitask_bench`.

Within-harness scaling only, never a cross-harness leaderboard: eliza contends
inside one shared `AgentRuntime` (`shared_runtime`), hermes/openclaw run
process-isolated turns (`process_per_turn`). Reports disclose isolation and
carry `cross_harness_comparable: false`.

## Run

```bash
# Direct — from packages/benchmarks/multitask-bench/
pip install -e .[test]   # one-time install (pulls sibling eliza-lifeops-bench)

# Live harness (needs CEREBRAS_API_KEY)
CEREBRAS_API_KEY=... python -m multitask_bench --harness hermes \
    --lanes 1,5,10 --model gemma-4-31b --output-dir results

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks multitask_bench --provider <p> --model <m>
```

`--lanes` must include 1 — it is the interference baseline and every delta is
undefined without it. Reports land at `<output-dir>/multitask_<timestamp>.json`.

## Smoke test (no API keys)

```bash
# Hermetic oracles — no keys, no model. Perfect scores 1.0 with zero
# interference; Wrong scores 0.0 with zero starvation.
python -m multitask_bench --harness perfect --lanes 1,5,10 --output-dir results
python -m multitask_bench --harness wrong --lanes 1,5 --output-dir results
```

## Test the harness

```bash
pip install -e .[test]   # one-time
pytest tests/ -v
```

The suite drives the real scheduler + real LifeOpsBench runner through the
frozen sample with the deterministic Perfect/Wrong oracles, plus unit coverage
for wave partitioning, Jain fairness, starvation classification, percentiles,
factory wiring, and the report schema round-trip.

## Layout

| Path | Role |
| --- | --- |
| `multitask_bench/__main__.py` | CLI entrypoint (argparse) |
| `multitask_bench/harness.py` | Per-lane `agent_factory` / `world_factory` per harness |
| `multitask_bench/scheduler.py` | Wave partitioning + concurrent lane execution |
| `multitask_bench/sample.py` | Frozen 10-scenario STATIC sample (all LifeOps surfaces) |
| `multitask_bench/metrics.py` | Lane metrics, interference deltas, Jain, starvation |
| `multitask_bench/report.py` | Report schema, validation, and writer |
| `multitask_bench/types.py` | `LaneResult` and friends |
| `tests/` | pytest suite (hermetic; session-scoped oracle lane fixtures) |

## Notes

- Tasks are batch-presented at t=0 in waves of exactly N: the sample is sliced
  `sample[k*N:(k+1)*N]` and each wave runs concurrently. N=1 is 10 sequential
  single-task waves.
- The eliza lane's per-session usage attribution rides the AsyncLocalStorage
  buffer in `packages/lifeops-bench/src/server.ts` (#13777) — each turn's
  MODEL_USED events bind to their own async call chain, so overlapping
  sessions never double-count cost or tokens.
- The openclaw lane needs the loopback completion gateway
  (`CLAUDE_SUBSCRIPTION_GATEWAY_URL` + `CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN`);
  direct OpenAI-compatible transport is reserved for adapter parser/retry
  tests and is excluded from campaign results.
- Registry result locator looks for `multitask_*.json` in the output dir.
- Scored by `_score_from_multitask_bench_json` in `registry/scores.py`:
  the scalar is `mean_task_score` of the N=10 lane. Higher is better.
- A report must contain all lanes and all ten task attempts per lane before it
  is written; partial lanes fail the run rather than publish a hollow report.
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
