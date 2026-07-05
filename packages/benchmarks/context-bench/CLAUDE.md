# Context-Bench — Agent Guide

Needle-in-a-haystack (NIAH), semantic NIAH, multi-hop context retrieval, and
conversation-compaction drift benchmark. Registered in the suite registry as
`context_bench`. Query path always routes through the elizaOS TypeScript
benchmark server (eliza adapter) — direct OpenAI/Anthropic/mock modes were
removed in favour of the TS bridge.

## Run

```bash
# Direct, from this directory (full matrix via eliza TS bridge)
python run_benchmark.py --provider eliza

# Quick mode: NIAH-basic only, 2 lengths × 3 positions × 2 tasks
python run_benchmark.py --provider eliza --quick

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks context_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
python run_benchmark.py --provider mock
```

The `mock` provider uses a deterministic local regex-based query function — no
API calls, no TS bridge.

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint; parses args, starts/stops eliza TS bridge |
| `elizaos_context_bench/runner.py` | Main benchmark execution loop |
| `elizaos_context_bench/suites/niah.py` | NIAH + semantic NIAH suite |
| `elizaos_context_bench/suites/multihop.py` | Multi-hop reasoning suite |
| `elizaos_context_bench/drift.py` | Conversation-compaction drift suite (aggregates TS harness JSONL) |
| `elizaos_context_bench/generator.py` | Context and needle generation |
| `elizaos_context_bench/evaluators/` | Retrieval + position (lost-in-the-middle) evaluators |
| `elizaos_context_bench/reporting.py` | ASCII heatmap + markdown report generation |
| `elizaos_context_bench/types.py` | Core type definitions |
| `tests/` | pytest suite |

## Notes

- Results write to `./benchmark_results/` (prefix `context_bench_*.json`).
- Scored by `_score_from_contextbench_json` in `registry/scores.py`.
- Drift harness (TypeScript): `scripts/benchmark/drift-harness.ts`. Dry-run
  mode is deterministic and requires no API keys; real runs use an
  OpenAI-compatible chat-completions endpoint.
- Optional extras: `pip install -e ".[embeddings]"` for semantic similarity
  scoring; `pip install -e ".[drift]"` for Python drift aggregation helpers.
- Full background and configuration reference: [README.md](README.md).

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
