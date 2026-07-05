# Experience Bench — Agent Guide

Evaluates the elizaOS experience service: retrieval quality (Precision@K, Recall@K,
MRR, Hit Rate@K), reranking correctness, and end-to-end learn-then-apply cycle
effectiveness. Not registered in the suite registry — run directly.

## Run

```bash
# Direct mode — no LLM required (default: 1000 experiences, 100 queries, 20 learning cycles)
python run_benchmark.py

# Custom scale
python run_benchmark.py --experiences 2000 --queries 200 --learning-cycles 50 --output results.json

# Agent mode via the elizaOS TypeScript benchmark bridge (requires ELIZA_BENCH_URL / ELIZA_BENCH_TOKEN)
python run_benchmark.py --mode eliza-agent --provider groq --model qwen3-32b
```

## Smoke test (no API keys)

The `direct` mode (default) runs entirely in-process without any LLM or external
service. It is the smoke path:

```bash
python run_benchmark.py --experiences 50 --queries 10 --learning-cycles 5
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint; `--mode direct\|eliza-agent\|eliza-bridge` |
| `elizaos_experience_bench/runner.py` | Direct benchmark execution loop |
| `elizaos_experience_bench/service.py` | In-process Python experience service (no TS dependency) |
| `elizaos_experience_bench/generator.py` | Synthetic experience + learning-scenario generator |
| `elizaos_experience_bench/evaluators/` | Retrieval, reranking, learning, and hard-case evaluators |
| `elizaos_experience_bench/types.py` | `BenchmarkConfig`, `BenchmarkResult`, metrics DTOs |
| `elizaos_experience_bench/eliza_runner.py` | Unused compatibility shim for the removed in-process Python runner; bridge modes route through `eliza_adapter.experience` directly in `run_benchmark.py` |
| `tests/` | pytest suite covering generator, evaluators, runner, and bridge |

## Notes

- Results write to the path given by `--output` (no default output directory; prints to stdout when omitted).
- Not registered in `registry/commands.py` or `registry/scores.py` — no orchestrator integration.
- Reproducible by default: seeded RNG (`--seed 42`). Change with `--seed`.
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
