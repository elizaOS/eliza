# WooBench — Agent Guide

Mystical reading conversation and revenue benchmark. Evaluates an agent's ability
to conduct tarot, I Ching, and astrology readings across 10 persona archetypes
(skeptic, true believer, emotional crisis, scammer, etc.) while correctly handling
payment conversion, crisis support, and scam resistance. Registered as `woobench`.

## Run

```bash
# Direct, from packages/benchmarks/
python -m benchmarks.woobench --model gpt-5 --output benchmark_results/

# Filter by divination system
python -m benchmarks.woobench --system tarot --model gpt-5

# Filter by persona archetype
python -m benchmarks.woobench --persona skeptic --model gpt-5

# Run a single scenario
python -m benchmarks.woobench --scenario skeptic_tarot_01 --model gpt-5

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks woobench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Deterministic dummy agent + heuristic evaluator — no credentials needed
python -m benchmarks.woobench --agent dummy --evaluator heuristic --model dummy

# Dry run — lists scenarios that would be executed, no agent calls
python -m benchmarks.woobench --dry-run

# dummy-charge smoke: exercises the payment action path with a mock payment URL
python -m benchmarks.woobench --agent dummy-charge --evaluator heuristic \
    --payment-mock-url http://localhost:9999 --model dummy
```

## Test the harness

```bash
pytest packages/benchmarks/woobench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `__main__.py` | CLI entrypoint (`python -m benchmarks.woobench`) |
| `runner.py` | Orchestration loop (concurrency, result aggregation) |
| `evaluator.py` | Per-scenario turn driver and payment detection |
| `scorer.py` | Aggregates scenario results into `BenchmarkResult` |
| `types.py` | Dataclasses: `Scenario`, `ScenarioResult`, `BenchmarkResult`, `RevenueResult` |
| `payment_actions.py` | Payment action parsing and dispatch |
| `payment_mock.py` | `MockPaymentClient` for harness tests |
| `personas/` | One module per persona archetype |
| `scenarios/` | Tarot, I Ching, and astrology scenario definitions |
| `tests/` | pytest suite (scorer unit tests + payment mock integration) |

## Notes

- Results write to `benchmark_results/woobench_<model>_<timestamp>.json` (gitignored).
- Scored by `_score_from_woobench_json` in `registry/scores.py`; `overall_score` (0–100) is normalized to 0–1.
- Supported agents: `eliza` (default, elizaOS TS bridge), `hermes`, `openclaw`, `smithers`, `dummy`, `dummy-charge`.
- Evaluator modes: `llm` (OpenAI-compatible judge, default) and `heuristic` (deterministic, no credentials).
- Payment flow tested via `--payment-mock-url` pointing at a mock payments service; see `payment_mock.py`.
- Full background: [README.md](README.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
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
