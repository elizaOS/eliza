# BFCL — Agent Guide

Berkeley Function-Calling Leaderboard benchmark: evaluates LLM function-calling
accuracy across single-turn (AST equality), multi-turn (executable runtime state
comparison), and agentic (web search, memory) categories. Registered in the suite
registry as `bfcl`.

## Run

```bash
# Direct — sample of 50 tests, default provider (Groq gpt-oss-120b)
python -m benchmarks.bfcl run --sample 50

# Direct — specific provider and model
python -m benchmarks.bfcl run --provider openai --model openai/gpt-5 --sample 50

# Direct — specific categories only
python -m benchmarks.bfcl run --categories simple,multiple,multi_turn_base

# Direct — full benchmark with network-gated categories enabled
python -m benchmarks.bfcl run --full --enable-network

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks bfcl --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
python -m benchmarks.bfcl run --mock --sample 10
```

## Test the harness

```bash
pytest bfcl/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `__main__.py` | CLI entrypoint (`python -m benchmarks.bfcl`) |
| `runner.py` | Main execution loop |
| `agent.py` | Agent abstraction (real + mock) |
| `dataset.py` | Dataset loading (HuggingFace or local) |
| `evaluators/` | AST, executable, and relevance evaluators |
| `executable_runtime/` | Vendored upstream tool implementations (GorillaFS, MathAPI, etc.) |
| `types.py` | `BFCLCategory`, `BFCLConfig`, leaderboard score types |
| `reporting.py` | Result printing and summary |
| `elizaos_bfcl/` | elizaOS action catalog for the eliza provider |
| `tests/` | pytest suite |
| `scripts/run_benchmark.py` | Standalone run script (alternative entrypoint) |

## Notes

- Results write to `./benchmark_results/bfcl/` as `bfcl_results_*.json` (gitignored).
- Scored by `_score_from_bfcl_json` in `registry/scores.py`.
- Network-gated categories (`rest_api`, `web_search_base`, `web_search_no_snippet`) are
  skipped without `--enable-network` and excluded from the accuracy denominator.
- Memory categories (`memory_kv`, `memory_vector`, `memory_rec_sum`) are skipped unless
  upstream `bfcl-eval` is installed.
- Vendored upstream sources are Apache 2.0; see `executable_runtime/NOTICE`.
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
