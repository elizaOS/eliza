# Mind2Web — Agent Guide

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).
Evaluates elizaOS agents on real-world web navigation and interaction tasks using the two-stage
MindAct pipeline (DeBERTa-v3 candidate ranker → LLM action predictor). Registered as `mind2web`.

## Run

```bash
# Direct, from packages/benchmarks/ (sample tasks, auto-detect provider from env)
PYTHONPATH=packages python -m benchmarks.mind2web --sample --provider groq --model openai/gpt-oss-120b

# Full benchmark from HuggingFace (requires datasets package)
PYTHONPATH=packages python -m benchmarks.mind2web --hf --max-tasks 50 --split test_task

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks mind2web --provider <p> --model <m>
```

## Smoke test (no API key)

```bash
# Oracle replay: deterministic ground-truth answer; scores 100% by design — CI only
PYTHONPATH=packages python -m benchmarks.mind2web --sample --mock
```

## Test the harness

```bash
# One-time install (from this directory)
pip install -e ".[dev]"

pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint (`python -m benchmarks.mind2web`) |
| `runner.py` | Benchmark orchestration loop |
| `eliza_agent.py` | elizaOS agent with `MIND2WEB_ACTION` action |
| `ranker.py` | MindAct stage-1 DeBERTa-v3 candidate ranker |
| `dataset.py` | Dataset loader (HuggingFace + local sample + fixtures) |
| `evaluator.py` | Step and task evaluation logic |
| `types.py` | Type definitions (`Mind2WebConfig`, `Mind2WebSplit`, etc.) |
| `tests/` | pytest suite (dataset, ranker, integration) |
| `tests/fixtures/mind2web_sample.pkl` | Bundled sample task fixture |

## Notes

- Results write to `./benchmark_results/mind2web/<timestamp>/` (gitignored).
- Result file pattern: `mind2web-results*.json`; located by `_mind2web_result` in `registry/commands.py`.
- Scored by `_score_from_mind2web_json` in `registry/scores.py`.
- Stage-1 ranker modes: `real` (DeBERTa-v3, ~750MB download, leaderboard-comparable),
  `oracle` (upper bound only — leaks GT), `none` (no filtering, diagnostic).
- `--mock` uses `OracleMind2WebAgent` (ground-truth replay, CI smoke tests only).
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
