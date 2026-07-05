# Action Calling — Agent Guide

Native function/tool-calling benchmark. Samples planner-style records from
`training/data/native/records/hermes-fc-v1.jsonl`, sends OpenAI-compatible
`tools` to the model, and scores the returned `tool_calls` on five axes.
Registered in the suite registry as `action-calling`.

## Run

```bash
# Direct, from the repo root (packages/benchmarks/)
python -m benchmarks.action-calling.cli \
    --provider vllm \
    --model eliza-1-9b \
    --out /tmp/action-calling-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```

## Smoke test (no API keys)

The `mock` provider echoes expected tool calls back, scoring 1.0 on all axes.
Falls back to `fixtures/smoke.jsonl` automatically when the full dataset is absent.

```bash
python -m benchmarks.action-calling.cli \
    --provider mock \
    --model smoke \
    --out /tmp/action-calling-smoke
```

## Test the harness

```bash
pytest packages/benchmarks/action-calling/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint and scoring logic |
| `fixtures/smoke.jsonl` | Minimal fixture record for mock/offline runs |
| `tests/test_action_calling_cli.py` | pytest suite for scoring helpers |

## Notes

- Results write to `<out>/action-calling-results.json` (path controlled by `--out`).
- Scored by `_score_from_action_calling_json` in `registry/scores.py`.
- Score = geometric mean of five sub-rates: `native_tool_calls_ok`, `tool_name_match`, `args_parse_ok`, `required_keys_ok`, `arguments_match`.
- Supports providers: `vllm`, `openai`, `groq`, `openrouter`, `anthropic`, `cerebras`, `eliza`, `hermes`, `openclaw`, `mock`.
- Harness selection (eliza/hermes/openclaw/smithers) can also be forced via `ELIZA_BENCH_HARNESS` or `BENCHMARK_HARNESS` env vars.
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
