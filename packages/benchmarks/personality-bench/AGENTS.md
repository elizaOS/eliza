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
bun run personality:judge --agent eliza

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
