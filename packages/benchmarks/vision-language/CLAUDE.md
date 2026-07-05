# Vision-Language Bench — Agent Guide

Vision-language + UI-grounding eval harness for the eliza-1 model line.
Covers TextVQA, DocVQA, ChartQA, ScreenSpot, and OSWorld via five adapters
sharing a uniform `BenchmarkAdapter` contract. Registered in the suite
registry as `vision_language`.

## Run

```bash
# Direct — all benchmarks, eliza-1-9b tier, 100 samples each
cd packages/benchmarks/vision-language
bun run start -- --tier eliza-1-9b --benchmark textvqa --samples 5000

# Per-benchmark env vars point to dataset roots
TEXTVQA_DATA_DIR=/data/textvqa      bun run start -- --tier eliza-1-9b --benchmark textvqa    --samples 5000
DOCVQA_DATA_DIR=/data/docvqa        bun run start -- --tier eliza-1-9b --benchmark docvqa     --samples 5349
CHARTQA_DATA_DIR=/data/chartqa      bun run start -- --tier eliza-1-9b --benchmark chartqa    --samples 2500
SCREENSPOT_DATA_DIR=/data/screenspot bun run start -- --tier eliza-1-9b --benchmark screenspot --samples 1272
OSWORLD_DATA_DIR=/data/osworld      bun run start -- --tier eliza-1-9b --benchmark osworld    --samples 369

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks vision_language --provider <p> --model <m>
```

## Smoke test (no model, no dataset download)

```bash
cd packages/benchmarks/vision-language
bun run smoke                                      # all 5 benchmarks, 5 samples each, stub runtime
bun run start -- --smoke --benchmark screenspot    # one benchmark
```

The `--smoke` flag uses checked-in fixtures under `samples/<benchmark>/smoke.json`
and a deterministic stub runtime. Completes in under 2 minutes with no API keys.

## Test the harness

```bash
cd packages/benchmarks/vision-language
bun run test      # vitest run
```

## Layout

| Path | Role |
| --- | --- |
| `src/runner.ts` | CLI entrypoint and main run loop |
| `src/types.ts` | Shared types: `BenchmarkAdapter`, `Sample`, `Prediction`, `BenchReport` |
| `src/runtime-resolver.ts` | Resolves `VisionRuntime` from tier/harness/provider flags |
| `src/adapters/` | Five adapters: textvqa, docvqa, chartqa, screenspot, osworld |
| `src/scorers/index.ts` | Per-benchmark scoring functions |
| `samples/<benchmark>/smoke.json` | Checked-in fixtures used by `--smoke` |
| `baselines.json` | Published Qwen2.5-VL baseline scores keyed by `tier::benchmark` |
| `tests/` | vitest suite: adapters, runner, scorers |

## Notes

- Results write to `results/<tier>-<benchmark>-<date>.json` (gitignored).
- Scored by `_score_from_vision_language_json` in `registry/scores.py`.
- OSWorld full runs require the OSWorld VM image; see `plugins/plugin-computeruse/src/osworld/`.
- `baseline_score` is sourced from `baselines.json`; `delta = score - baseline_score`.
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
