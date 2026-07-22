# Mind2Web — Agent Guide

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).
Evaluates elizaOS agents on real-world web navigation and interaction tasks using the two-stage
MindAct pipeline (DeBERTa-v3 candidate ranker → LLM action predictor). Registered as `mind2web`.

## Run

```bash
# Explicit non-publishable smoke run
PYTHONPATH=packages python -m benchmarks.mind2web --sample --mock

# Validate a complete pinned test split without spending model quota
MIND2WEB_DISABLE_DATA_DOWNLOAD=1 PYTHONPATH=packages \
  python -m benchmarks.mind2web --hf --split test_task --count-scenarios \
  --expected-tasks 252

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
| `dataset.py` | Checksum-pinned encrypted official test archive, explicit local data, and smoke fixtures |
| `evaluator.py` | Upstream-compatible exact element/action and macro task scoring |
| `types.py` | Type definitions (`Mind2WebConfig`, `Mind2WebSplit`, etc.) |
| `tests/` | pytest suite (dataset, ranker, integration) |
| `tests/fixtures/mind2web_sample.pkl` | Bundled sample task fixture |

## Notes

- Results write to `./benchmark_results/mind2web/<timestamp>/` (gitignored).
- Result file pattern: `mind2web-results*.json`; located by `_mind2web_result` in `registry/commands.py`.
- Scored by `_score_from_mind2web_json` in `registry/scores.py`.
- Full runs load the encrypted official `test.zip` at revision
  `17ece8eb89862368edc0cc806acee6fca5163474`, verify SHA-256
  `8f5fbe72afab942fe97cdf7fb397e179885d89b5c16862288e9a14bc6d41ca89`,
  and require exact split counts (252 / 177 / 912). Data or parse failures never
  fall back to samples or train data.
- Stage-1 `real` mode pins the released MindAct ranker revision
  `92d3ddcb079b1749015d72293c82d640b0b9a1da`; `oracle` leaks ground truth and
  `none` is diagnostic. Only `real` is accepted by production scoring.
- Full runs reuse OSU's released candidate-generation scores, pinned at
  SHA-256 `884c97cd9ae0544485d21ea39e0d46422aee0291969a7324e56df3a84466dbd7`,
  so all harnesses receive exactly the same top-50 and do not repeat a
  deterministic 630-candidates-per-step ranker workload.
- Eliza, Hermes, and OpenClaw all receive the same pruned-DOM action surface,
  ranked top-50 candidates, prior actions, required action schema, and no
  current/future annotated action. Invalid output remains an invalid prediction.
- Cohort results use the official corpus, ranker, and macro scoring contract,
  but the Claude action protocol and derived edge variants are not claimed as
  published MindAct leaderboard entries.
- `--mock` uses `OracleMind2WebAgent` (ground-truth replay, CI smoke tests only).
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
