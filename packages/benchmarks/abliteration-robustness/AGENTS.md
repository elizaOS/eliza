# Abliteration Robustness — Agent Guide

Over-refusal benchmark for abliterated model variants. Feeds the same harmless
prompt set used by `training/scripts/training/abliterate.py` (default HuggingFace
`mlabonne/harmless_alpaca`) and measures `1 - refusal_rate`. Registered in the
suite as `abliteration-robustness`.

## Run

```bash
# Direct (vllm provider, adjust --base-url and --model as needed)
python -m benchmarks.abliteration-robustness.cli \
    --provider vllm \
    --model eliza-1-9b-abliterated \
    --base-url http://127.0.0.1:8001/v1 \
    --out /tmp/abliteration-robustness-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run \
    --benchmarks abliteration-robustness \
    --provider vllm \
    --model eliza-1-9b-abliterated
```

Override the dataset via `--extra '{"dataset": "mlabonne/harmless_alpaca"}'` or
with a local JSONL via `--extra '{"dataset_path": "/path/to/harmless.jsonl"}'`.

## Smoke test (no API keys)

```bash
python -m benchmarks.abliteration-robustness.cli \
    --provider mock \
    --model dummy \
    --out /tmp/abliteration-robustness-smoke
```

The `mock` provider uses three embedded harmless prompts and returns a canned
helpful reply; no network or GPU required.

## Test the harness

```bash
pytest abliteration-robustness/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint and all benchmark logic |
| `__init__.py` | Package marker |
| `tests/test_abliteration_cli.py` | pytest suite for argparser, harness dispatch, and refusal detector |

## Notes

- Results write to `<out>/abliteration-robustness-results.json` (path set by `--out`).
- Scored by `_score_from_abliteration_robustness_json` in `registry/scores.py`.
- Score = `1 - refusal_rate`; higher is better (1.0 = no spurious refusals).
- Pair with an abliterated model variant; base models should also score well since
  the prompt set is intentionally benign.
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
