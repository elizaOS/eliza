# personality-bench — Agent Guide

Layered judge for personality consistency evaluation. Grades agent trajectories
across five behavioural buckets: `shut_up`, `hold_style`, `note_trait_unrelated`,
`escalation`, and `scope_global_vs_user`. Not registered in the suite orchestrator
— invoked directly or via the root `personality:bench` script.

## Run

```bash
# Grade a recorded run directory (from repo root)
bun run packages/benchmarks/personality-bench/src/runner.ts \
  --run-dir ~/.eliza/runs/personality/<agent>-<ts> \
  --output report.md \
  --output-json report.json

# Via the root workspace script
bun run bench:personality --agent eliza

# Via the package script (from this directory)
bun run grade -- --run-dir <path> --output report.md --output-json report.json
```

## Smoke test (calibration corpus, no run directory needed)

```bash
# Run against the built-in calibration corpus (no API keys required for phrase-only)
bun run packages/benchmarks/personality-bench/src/runner.ts \
  --calibration \
  --output /tmp/calib-report.md \
  --output-json /tmp/calib-report.json
```

## Test the harness

```bash
# Full test suite
cd packages/benchmarks/personality-bench
bun x vitest run

# Calibration suite only (verbose)
bun x vitest run tests/judge.test.ts --reporter=verbose
```

## Layout

| Path | Role |
| --- | --- |
| `src/runner.ts` | CLI entrypoint — grades a run dir or calibration corpus |
| `src/index.ts` | Public API exported by the package |
| `src/judge/index.ts` | Judge orchestrator (phrase → LLM → embedding layers) |
| `src/judge/verdict.ts` | Verdict combiner (conservative weighting) |
| `src/judge/rubrics/` | One file per bucket rubric |
| `src/judge/checks/` | Shared checks: phrase, LLM judge, embedding, injection |
| `src/types.ts` | All shared types (`PersonalityScenario`, `PersonalityVerdict`, etc.) |
| `src/bridge.ts` | Integration bridge for upstream scenario producers |
| `tests/` | Vitest suite — unit + calibration + W3-2 smoke |
| `tests/calibration/` | Ground-truth corpus (66 hand-graded + 21 adversarial JSONL) |

## Notes

- The LLM judge layer requires `CEREBRAS_API_KEY`. Set `PERSONALITY_JUDGE_ENABLE_LLM=0`
  to skip it and run phrase/trajectory layers only (sufficient for calibration corpus).
- Embedding fallback is off by default; enable with `PERSONALITY_JUDGE_ENABLE_EMBEDDING=1`.
- `PERSONALITY_JUDGE_STRICT=1` collapses `NEEDS_REVIEW` to `FAIL` (recommended for CI).
- Output files (`report.md`, `report.json`) are written to the current directory by default;
  redirect with `--output` / `--output-json`. These are not committed.
- Not scored by `registry/scores.py` — this package is a judge library, not an orchestrated benchmark.
- Full background, calibration log, and environment variables: [README.md](README.md).

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
