# Orchestrator Lifecycle — Agent Guide

Multi-turn orchestration lifecycle benchmark: evaluates the elizaOS agent's
ability to handle clarification requests, status check-ins, scope changes,
pause/resume/cancel interruptions, and stakeholder summaries across scripted
scenario conversations. Registered in the suite as `orchestrator_lifecycle`.

## Run

```bash
# Direct (bridge mode — real elizaOS TS agent via bench server)
python -m benchmarks.orchestrator_lifecycle.cli \
  --provider openai --model gpt-4o \
  --output ./benchmark_results/orchestrator-lifecycle

# Through the suite orchestrator (manages provider/model, stores results)
python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle --provider <p> --model <m>
```

## Smoke test (no API keys, no TS server)

```bash
python -m benchmarks.orchestrator_lifecycle.cli \
  --mode simulate \
  --max-scenarios 3 \
  --output /tmp/olc-smoke
```

`--mode simulate` uses a deterministic keyword-based reply function. It does
not call any LLM or start the elizaOS bench server. Scores from simulate mode
are not meaningful for real evaluation.

## Test the harness

```bash
# From the repo root (benchmarks package must be importable)
pytest packages/benchmarks/orchestrator_lifecycle/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | Argument parser + `main()` entrypoint |
| `runner.py` | `LifecycleRunner` — bridge and simulate execution modes |
| `evaluator.py` | Keyword-based behavior scoring per turn |
| `dataset.py` | Loads scenario JSON files |
| `reporting.py` | Writes result JSON to output dir |
| `types.py` | `LifecycleConfig`, `ScenarioResult`, `LifecycleMetrics` |
| `scenarios/` | 12 JSON scenario definitions + schema |
| `tests/` | pytest suite (smoke + evaluator + dataset + schema) |

## Notes

- Results write to `./benchmark_results/orchestrator-lifecycle/` as
  `orchestrator-lifecycle-<timestamp>.json` (gitignored).
- Scored by `_score_from_orchestrator_lifecycle_json` in `registry/scores.py`.
- Bridge mode (default for LLM providers) forwards each turn to the elizaOS TS
  bench server (`packages/app-core/src/benchmark/server.ts`) via
  `ElizaClient.send_message`. Set `ELIZA_BENCH_URL` to reuse a running server.
- Simulate mode is kept only for offline CI smoke-testing; it does not measure
  the real agent.
- Full scenario schema: [scenarios/README.md](scenarios/README.md).
