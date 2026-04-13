# Milady Benchmark Testing Protocol

This protocol defines benchmark-focused tests for Milady's benchmark bridge (`src/benchmark/`).

## Scope

Covers:

- `BENCHMARK_ACTION` capture and parameter parsing
- benchmark provider context shaping (`MILADY_BENCHMARK`)
- deterministic mock benchmark model behavior
- compatibility checks against `cua-bench` benchmark primitives

## Required checks before merge

From the repository root:

```bash
bunx vitest run src/benchmark/*.test.ts
```

This runs all benchmark unit tests in `src/benchmark/*.test.ts`.

For a watchable execution run:

```bash
bun run benchmark:watch
```

For live CUA execution in the LUME VM (opens apps/tabs via plugin-cua):

```bash
CUA_HOST=localhost:8000 OPENAI_API_KEY=sk-... CUA_COMPUTER_USE_MODEL=computer-use-preview bun run benchmark:cua:watch
```

## Action contract checklist

When benchmark logic changes, confirm:

1. **Action capture correctness**
   - command-style actions are preserved (`command`)
   - tool-style actions parse `tool_name` + `arguments`
   - invalid JSON arguments are handled safely (`_raw` fallback)
2. **Provider context quality**
   - benchmark/task identifiers are present
   - task/tool/element context appears in provider text
3. **Template enforcement**
   - prompt template still requires `BENCHMARK_ACTION` for action benchmarks

## CUA-bench compatibility smoke checks

If `cua` is checked out at `/Users/research/cua`, run:

```bash
cd /Users/research/cua/libs/cua-bench
uv run --with pytest pytest cua_bench/tests/test_actions.py -v
uv run --with pytest pytest cua_bench/tests/test_run_benchmark.py -v
```

These validate the underlying benchmark action/runner contracts we align Milady with.

## Optional server bridge smoke

Run Milady benchmark server with deterministic mock behavior:

```bash
MILADY_BENCH_MOCK=true node --import tsx src/benchmark/server.ts
```

Then probe:

- `GET /api/benchmark/health`
- `POST /api/benchmark/reset`
- `POST /api/benchmark/message`

and confirm response includes actionable `actions` + `params`.
