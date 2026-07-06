# VisualWebBench — Agent Guide

Seven-subtask multimodal web understanding and grounding benchmark, faithfully
implementing [VisualWebBench](https://huggingface.co/datasets/visualwebbench/VisualWebBench)
(Apache-2.0). Evaluates ROUGE-L (captions/OCR), F1 (WebQA), and MCQ accuracy
(grounding/action). Registered in the suite registry as `visualwebbench`.

## Run

```bash
# Direct, from packages/benchmarks/visualwebbench/
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --max-tasks 70

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks visualwebbench --provider <p> --model <m>
```

## Smoke test (no API keys, no HF download)

```bash
PYTHONPATH=packages:packages/benchmarks/eliza-adapter \
  python -m benchmarks.visualwebbench --use-sample-tasks --mock --max-tasks 7
```

`--mock` echoes `task.answer` through the oracle agent (always 100 %). Combined
with `--use-sample-tasks` it uses the bundled 7-row JSONL fixture — one row per
subtask, no images, no network calls. Scores from this path are not comparable
to upstream.

## Test the harness

```bash
pip install -e ".[dev]"
pytest visualwebbench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | Argument parsing, `main()` entrypoint |
| `__main__.py` | `python -m benchmarks.visualwebbench` hook |
| `runner.py` | Async execution loop across all subtasks |
| `agent.py` | Eliza adapter + oracle mock agent |
| `dataset.py` | HF streaming loader and JSONL fixture reader |
| `evaluator.py` | Per-subtask ROUGE / F1 / MCQ scorers |
| `types.py` | Dataclasses and enums (`VisualWebBenchTaskType`, etc.) |
| `fixtures/smoke.jsonl` | 7-row offline fixture (one per subtask, no images) |
| `fixtures/local_vlm_real.jsonl` | Sample rows for local VLM (eliza-1) testing |
| `tests/test_visualwebbench.py` | pytest suite (metric unit tests + runner smoke) |

## Notes

- Results write to `benchmark_results/visualwebbench/<timestamp>/` (gitignored).
  Output files: `visualwebbench-results.json`, `summary.md`, `traces/<task-id>.json`.
- The `_visualwebbench_result` locator in `registry/commands.py` expects
  `visualwebbench-results.json` at the root of `output_dir`.
- Scored by `_score_from_visualwebbench_json` in `registry/scores.py`.
- HF dataset: `visualwebbench/VisualWebBench`, split `test`, seven configs (one
  per subtask). Images are lazily fetched and cached as PNG under
  `~/.cache/elizaos/visualwebbench/images/` by default.
- Use `--max-tasks N` to cap downloads during development.
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
