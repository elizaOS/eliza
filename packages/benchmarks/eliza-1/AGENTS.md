# eliza-1 Bench — Agent Guide

Quality and performance benchmark for eliza-1 models. Evaluates three
structured-output tasks — response-handler (`should_respond`), action planner
(`planner`), and per-action parameter extraction (`action:<name>`) — across
four decoding modes: unguided, GBNF-guided, strict-guided, and Cerebras
(Llama-3.1-8B / GPT-OSS-120B as reference). Not registered in the suite
registry; run directly via Bun.

## Run

```bash
# From repo root — run all tasks, all modes, 10 generations each
bun run --cwd packages/benchmarks/eliza-1 start

# Specific task and mode
bun run --cwd packages/benchmarks/eliza-1 start \
  --task should_respond --mode guided --n 5

# Specific eliza-1 tier (GGUF must be on disk)
bun run --cwd packages/benchmarks/eliza-1 start \
  --tier eliza-1-9b --task all --mode unguided,guided

# Skip local engine modes when GGUF is unavailable (CI-safe)
bun run --cwd packages/benchmarks/eliza-1 start \
  --mode cerebras --allow-skip-local

# From inside this directory
bun run src/index.ts --task planner --mode guided --n 3
```

Available tiers: `eliza-1-0_8b` (default), `eliza-1-2b`, `eliza-1-4b`,
`eliza-1-9b`, `eliza-1-27b`, `eliza-1-27b-256k`.

Env: `CEREBRAS_API_KEY` enables the cerebras mode. `ELIZA_BENCH_SKIP_ENGINE=1`
force-skips local engine modes.

## Smoke test (no API keys, no GGUF)

The test suite runs entirely with mock `ModeAdapter` instances and does not
require the local engine or `CEREBRAS_API_KEY`:

```bash
bun run --cwd packages/benchmarks/eliza-1 test
```

## Fixture derivation (dry-run)

```bash
bun run --cwd packages/benchmarks/eliza-1 fixtures:derive:dry-run
```

## Vision CUA e2e sub-harness (stub mode)

```bash
# Generate synthetic PNG fixtures (idempotent)
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e fixtures:generate

# Run the pipeline harness in stub mode (no inference, no OS mouse)
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test
```

## Test the harness

```bash
# Main bench unit tests (metrics, runner, report)
bun run --cwd packages/benchmarks/eliza-1 test

# Vision CUA e2e harness tests
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test
```

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | CLI entrypoint; flag parsing, mode selection |
| `src/runner.ts` | Task × mode orchestrator; `runBench()` |
| `src/metrics.ts` | Scoring helpers: parse, schema check, label match, percentiles |
| `src/report.ts` | Console table + JSON report writer |
| `src/types.ts` | Shared types: `BenchReport`, `CaseMetric`, `ModeAdapter` |
| `src/modes/` | `cerebras.ts`, `eliza-guided.ts`, `eliza-strict-guided.ts`, `eliza-unguided.ts` |
| `src/tasks/` | `should-respond.ts`, `planner.ts`, `action.ts` — fixture loaders + runners |
| `src/fixtures/` | JSON fixture files for all three tasks |
| `scripts/derive-fixtures.mjs` | Fixture derivation script (call via `fixtures:derive`) |
| `__tests__/runner.test.ts` | vitest suite (mock modes; no inference needed) |
| `vision-cua-e2e/` | Integration scaffold for the vision + CUA pipeline |

## Notes

- Results write to `./bench-results-<ISO>.json` by default; override with `--out <path>`.
- Not registered in the suite registry; there is no orchestrator invocation path.
- The vitest suite exercises all metric helpers and the runner's mock-mode path — safe to run on CI without keys or GGUF.
- Vision CUA e2e runs in stub mode by default; set `ELIZA_VISION_CUA_E2E_REAL=1` + wire real plugin adapters for live runs (see `vision-cua-e2e/README.md`).
- Vision CUA trace JSONs write to `vision-cua-e2e/reports/` (gitignored).
- Full background: [vision-cua-e2e/README.md](vision-cua-e2e/README.md).
