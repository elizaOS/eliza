# memperf — Agent Guide

Desktop/server memory-benchmark harness (issue #8809). Records, per available
Eliza-1 **tier × modality** (`text`, `embedding`, `transcription`, `tts`, `vad`,
`vision`): load ms, resident RSS delta, peak RSS, tok/s or RTF, and the
`MemoryArbiter` eviction count under a scripted co-residency sequence. Emits a
JSON report on the shared `METRIC_SCHEMA` (shared with #8800), checks
`budgets.json`, and exits non-zero on regression. Not registered in the suite
orchestrator — run directly with `node` / `bun`.

## Run

```bash
# Full harness + consolidated dashboard (results/summary/latest.md + .json)
bun run bench:memperf
node packages/benchmarks/memperf/run-all.mjs            # equivalent
bun run bench:memperf:json                              # JSON to stdout

# The measuring harness directly (TS — imports real plugin services):
bun --conditions=eliza-source packages/benchmarks/memperf/memperf-kpi.ts
bun --conditions=eliza-source packages/benchmarks/memperf/memperf-kpi.ts --json

# Limit tiers / generation length:
MEMPERF_TIERS=eliza-1-2b,eliza-1-4b bun --conditions=eliza-source \
  packages/benchmarks/memperf/memperf-kpi.ts
MEMPERF_MAX_TOKENS=64 bun run bench:memperf
```

`--conditions=eliza-source` is required — the harness imports
`@elizaos/plugin-local-inference` source (`MemoryArbiter`, engine, hardware
probe) under the `eliza-source` export condition.

## Smoke test (no models, CI-safe)

```bash
# No model bundle installed → all (tier × modality) rows skip with a concrete
# reason, the co-residency self-check exercises the real arbiter fit/pressure
# eviction telemetry, and the harness exits 2 (skipped). Runs anywhere.
bun run bench:memperf
```

## Test the harness

```bash
bun test --conditions=eliza-source packages/benchmarks/memperf/metric-schema.test.ts
bun test --conditions=eliza-source packages/benchmarks/memperf/co-residency.test.ts

# Typecheck (memperf is not a workspace package; use its standalone config):
node_modules/.bin/tsgo --noEmit -p packages/benchmarks/memperf/tsconfig.check.json
```

- `metric-schema.test.ts` pins the field set shared with #8800 (a rename/drop
  fails the test and must bump `METRIC_SCHEMA_VERSION`).
- `co-residency.test.ts` drives the **real** `MemoryArbiter` with synthetic
  sized loaders and asserts the LRU fit-path and the critical-pressure path both
  emit the eviction telemetry the harness counts — no models, no FFI.

## Layout

| Path | Role |
| --- | --- |
| `memperf-kpi.ts` | Measuring harness (real arbiter + engine + hardware probe) |
| `run-all.mjs` | Orchestrator: spawns the harness, writes the dashboard, propagates exit code |
| `metric-schema.mjs` | `METRIC_SCHEMA` shared with #8800 + the skipped-row builder |
| `lib.mjs` | RSS sampling, result recording, git context, budget loader |
| `budgets.json` | Per-tier peak-RSS + co-residency eviction budgets |
| `metric-schema.test.ts` / `co-residency.test.ts` | Schema + arbiter-telemetry tests |
| `tsconfig.check.json` | Standalone typecheck config (memperf is not a workspace package) |
| `results/` | Timestamped JSON results (gitignored; only `.gitignore` committed) |

## Notes / gotchas

- **Honesty contract.** A row is `measured: true` only on a real load+run;
  otherwise `measured: false` with a `skipReason`. Numeric fields are `null`
  (never `0`) when unmeasured. The co-residency self-check (`mode: "self-check"`)
  is never a tier metric and can never satisfy the real eviction-regression gate,
  but it DOES fail loudly if the arbiter stops counting evictions.
- **A real measured row requires a curated Eliza-1 tier bundle** (id
  `eliza-1-*`) installed via the local-inference registry — the fused
  `libelizainference` backend resolves models from the bundle layout
  (`.../text/*.gguf`), not from bare external GGUF blobs. External LM-Studio /
  Ollama / HF scans are deliberately NOT measured as Eliza-1 tiers.
- **Exit codes:** `0` pass, `1` budget/telemetry regression, `2` nothing
  measurable (self-check passed) — usable directly as a CI gate.
- **Results** write to `results/memperf/latest.json` and
  `results/summary/latest.md` (the `results/` tree is gitignored).
- The metric schema mirrors
  `plugins/plugin-local-inference/docs/memory-and-e2e-latency-review.md` §5 and
  the iOS grind (`plugin-capacitor-bridge/src/ios/model-grind.ts`); #8809 owns
  the desktop/server harness + arbiter telemetry, #8800 owns the mobile surface
  and consumes the same `METRIC_SCHEMA`.
- Full overview + env reference: [README.md](README.md).
