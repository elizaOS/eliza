# Vending-Bench — Agent Guide

elizaOS reimplementation of Andon Labs' Vending-Bench ([arXiv 2502.15840](https://arxiv.org/abs/2502.15840),
[leaderboard](https://andonlabs.com/evals/vending-bench)): evaluates LLM long-horizon coherence by
simulating a vending-machine business over up to 30 days (inventory ordering, pricing, cash management).
Headline score is net worth at end of run. Registered as `vending_bench`.

## Run

```bash
# Direct — heuristic agent (no API key needed for quick structural check)
python -m elizaos_vending_bench.cli run --provider heuristic --runs 5 --days 30

# Direct — OpenAI
python -m elizaos_vending_bench.cli run --provider openai --model gpt-4o --runs 5 --days 30

# Direct — Anthropic
python -m elizaos_vending_bench.cli run --provider anthropic --model claude-sonnet-4-6 --runs 5 --days 30

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks vending_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Heuristic agent runs without any LLM provider
python -m elizaos_vending_bench.cli run --provider heuristic --runs 1 --days 3 --starter-inventory
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest elizaos_vending_bench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_vending_bench/cli.py` | CLI entrypoint (`vending-bench` script + `python -m elizaos_vending_bench.cli`) |
| `elizaos_vending_bench/runner.py` | Main execution loop |
| `elizaos_vending_bench/environment.py` | Vending machine simulation (inventory, sales, cash) |
| `elizaos_vending_bench/agent.py` | LLM agent interface and heuristic fallback |
| `elizaos_vending_bench/evaluator.py` | Coherence scoring and metrics |
| `elizaos_vending_bench/providers/` | OpenAI and Anthropic provider implementations |
| `elizaos_vending_bench/types.py` | Shared dataclasses and enums |
| `elizaos_vending_bench/reporting.py` | Markdown report generation |
| `elizaos_vending_bench/tests/` | pytest suite (unit + integration) |
| `run_benchmark.py` | Standalone script (heuristic, 10 runs, fixed seed) |

## Notes

- Results write to `./benchmark_results/vending-bench/vending-bench-results-<timestamp>.json` (gitignored).
- Scored by `_score_from_vendingbench_json` in `registry/scores.py`.
- Orchestrator command uses `--starter-inventory` and `--max-actions-per-day 6` by default.
- The `--provider eliza` path routes through the elizaOS TS benchmark bridge (`eliza-adapter`).
- Full background: [RESEARCH.md](RESEARCH.md).

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
