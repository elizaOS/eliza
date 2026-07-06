# Trust — Agent Guide

Adversarial security detection benchmark: evaluates an agent's ability to identify
prompt injection, social engineering, impersonation, credential theft, privilege escalation,
data exfiltration, resource abuse, and content policy violations. 165 cases across 9 categories
(130 malicious + 35 benign false-positive controls). Registered in the suite registry as `trust`.

## Run

```bash
# Direct, from this directory (defaults to oracle handler — no API keys needed)
python run_benchmark.py

# With a specific handler
python run_benchmark.py --handler oracle        # perfect-score baseline (validates framework)
python run_benchmark.py --handler random        # coin-flip baseline (validates discrimination)
python run_benchmark.py --handler eliza         # LLM-based via elizaOS TS bridge
python run_benchmark.py --handler llm           # direct OpenAI-compatible endpoint

# Filter options
python run_benchmark.py --categories prompt_injection social_engineering
python run_benchmark.py --difficulty hard
python run_benchmark.py --tags encoding multi-language
python run_benchmark.py --threshold 0.8 --output results.json

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks trust --provider <p> --model <m>
```

## Smoke test (no API keys)

The oracle handler is fully deterministic and requires no credentials. It validates
the benchmark framework itself and must always score 100%.

```bash
python run_benchmark.py --handler oracle
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint; handler registration and argument parsing |
| `elizaos_trust_bench/runner.py` | Benchmark execution loop and metrics aggregation |
| `elizaos_trust_bench/corpus.py` | 165 test cases across 9 threat categories |
| `elizaos_trust_bench/baselines.py` | `PerfectHandler` (oracle) and `RandomHandler` baselines |
| `elizaos_trust_bench/scorer.py` | Precision, recall, F1, and false-positive-rate computation |
| `elizaos_trust_bench/types.py` | `TrustHandler` protocol, `BenchmarkConfig`, enums |
| `elizaos_trust_bench/reporter.py` | Console and JSON report formatting |
| `tests/` | pytest suite covering corpus, scorer, and baselines |

## Notes

- Results write to the path given by `--output` (default: none; orchestrator writes `trust-results.json`).
- Scored by `_score_from_trust_json` in `registry/scores.py`.
- When the orchestrator runs with `provider=mock`, it automatically uses the oracle handler.
- Metrics: per-category precision/recall/F1, overall macro F1, false-positive rate, difficulty breakdown.
- To test a custom agent, implement the `TrustHandler` protocol from `elizaos_trust_bench.types` and
  pass it directly to `TrustBenchmarkRunner.run_and_report()` — see [README.md](README.md).
- Full background and test case design philosophy: [README.md](README.md).

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
