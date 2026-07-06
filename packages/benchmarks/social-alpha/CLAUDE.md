# Social-Alpha — Agent Guide

Trust marketplace benchmark that evaluates systems on real Discord crypto-chat data
from the ElizaOS Trenches community. Measures four capabilities via the
EXTRACT / RANK / DETECT / PROFIT suites and produces a composite Trust Marketplace
Score (TMS). Registered in the suite registry as `social_alpha`.

## Run

```bash
# Direct, from this directory — rule-based baseline, bundled smoke fixture
python -m benchmark.harness --data-dir fixtures/smoke-data --system baseline

# With the full Trenches Chat dataset (267k messages, requires download)
python -m benchmark.harness --data-dir trenches-chat-dataset/data --system baseline

# LLM-backed full system (requires provider keys)
python -m benchmark.harness --data-dir trenches-chat-dataset/data --system full --model groq/llama-3.3-70b-versatile

# Run a single suite
python -m benchmark.harness --data-dir fixtures/smoke-data --suite extract

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks social_alpha --provider <p> --model <m>
```

Available `--system` values: `baseline` (rule-based, no LLM), `smart` (improved
heuristics), `full` (LLM extraction), `oracle` (perfect-knowledge upper bound),
`eliza-bridge` (TypeScript agent via elizaOS bridge).

## Smoke test (no API keys)

The harness falls back to `fixtures/smoke-data` automatically when the full dataset
is absent. Running baseline against the fixture needs no keys:

```bash
python -m benchmark.harness --data-dir fixtures/smoke-data --system baseline
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `benchmark/harness.py` | CLI entrypoint (`python -m benchmark.harness`) |
| `benchmark/suites/` | Four scored suites: `extract`, `rank`, `detect`, `profit` |
| `benchmark/systems/` | System implementations: `full_system`, `oracle`, `smart_baseline`, `token_registry` |
| `benchmark/protocol.py` | Abstract `SocialAlphaSystem` interface + dataclasses |
| `benchmark/ground_truth.py` | Ground-truth generation and caching |
| `fixtures/smoke-data/` | Bundled minimal fixture for key-free runs |
| `trenches-chat-dataset/` | Full dataset (267k messages; fetched separately) |
| `tests/` | pytest suite |

## Notes

- Results write to the `--output` directory as `benchmark_results_<system>.json` (not committed).
- Composite TMS weights: EXTRACT 25%, RANK 30%, DETECT 25%, PROFIT 20%.
- Scored by `_score_from_social_alpha_json` in `registry/scores.py`; score is TMS / 100 (ratio, higher is better).
- Full dataset schema and download instructions: [trenches-chat-dataset/README.md](trenches-chat-dataset/README.md).

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
