# RLM-Bench — Agent Guide

Recursive Language Model benchmark: S-NIAH (streaming needle-in-a-haystack) +
OOLONG (long-document retrieval/reasoning) from
[arXiv:2512.24601](https://arxiv.org/abs/2512.24601). Registered in the suite
registry as `rlm_bench`.

## Run

```bash
# Direct, from this directory
python run_benchmark.py --mode rlm --backend gemini \
  --dual-model --root-model gemini-2.0-flash --subcall-model gemini-2.0-flash

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks rlm_bench --provider <p> --model <m>
```

Modes: `stub` (mock LLM), `rlm` (RLM plugin), `eliza` (elizaOS runtime), `custom`.

## Smoke test (no API keys)

```bash
python run_benchmark.py --mode stub --context-lengths 1000,10000
```

Stub mode is deterministic and offline — used for readiness/CI checks.

## Test the harness

```bash
pip install -e .[dev]                  # once, from this directory
pytest elizaos_rlm_bench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint (`--mode stub\|rlm\|eliza\|custom`) |
| `elizaos_rlm_bench/generator.py` | Task generation (S-NIAH, OOLONG) |
| `elizaos_rlm_bench/runner.py` | Execution loop |
| `elizaos_rlm_bench/evaluator.py` | Scoring |
| `elizaos_rlm_bench/reporting.py` | JSON + markdown report writers |
| `elizaos_rlm_bench/tests/` | pytest suite |

## Notes

- Results write to `benchmark_results/rlm-bench/` (gitignored).
- Scored by `_score_from_rlmbench_json` in `registry/scores.py`.
- Paper tables, strategy analysis, and plugin integration: [README.md](README.md).

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
