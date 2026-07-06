# scambench — Agent Guide

Adversarial scam-detection benchmark: scores a model on two axes simultaneously —
refusal-correctness on scam prompts and helpfulness on legitimate prompts.
Combined into a single `metrics.score` in [0, 1]. Registered as `scambench`.

## Run

```bash
# Direct, from packages/benchmarks/
python -m benchmarks.scambench.cli \
    --provider vllm \
    --model eliza-1-9b \
    --out /tmp/scambench-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks scambench --provider vllm --model eliza-1-9b
```

## Smoke test (no API keys)

`--provider mock` skips all LLM calls and uses deterministic replies:

```bash
python -m benchmarks.scambench.cli \
    --provider mock \
    --model smoke \
    --out /tmp/scambench-smoke
```

The CLI also falls back automatically to two embedded records when the training
corpus (`packages/training/data/normalized/scambench.jsonl`) is absent.

## Test the harness

```bash
PYTHONPATH=/path/to/eliza/packages pytest packages/benchmarks/scambench -v
```

No install step — the package is part of the monorepo `benchmarks` namespace.

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint; scoring loop; `--provider mock` path |
| `tests/test_scambench_cli.py` | pytest suite for refusal detector + harness logic |
| `scripts/import_feed.py` | One-off importer from FeedSocial/scambench upstream |
| `__init__.py` | Package marker |

## Notes

- Results write to `<--out>/scambench-results.json`.
- Scored by `_score_from_scambench_json` in `registry/scores.py`.
- Supports optional LLM judge (`--judge` / `--judge-model`) for refusal classification instead of regex.
- Multilingual refusal patterns cover English, Spanish, Portuguese, Thai, Chinese, and Hindi.
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
