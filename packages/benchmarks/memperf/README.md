# memperf — desktop/server memory-benchmark harness

A runnable desktop/server harness (issue #8809) that, for each available
Eliza-1 **tier × modality** (`text`, `embedding`, `transcription`, `tts`,
`vad`, `vision`), records:

- **load ms** — wall-clock to bring the model online,
- **resident RSS delta** — `process.memoryUsage().rss` sampled before/after the load,
- **peak RSS** — the worst RSS observed across the load+run window,
- **throughput** — tokens/sec (text/embedding/vision) or RTF (transcription/tts/vad),
- **arbiter eviction count** — taken from the `MemoryArbiter`'s own `onEvent`
  telemetry under a scripted co-residency sequence
  (`load text → load vision → load voice → force pressure`).

It emits a JSON report whose per-row shape is the shared `METRIC_SCHEMA`
(`metric-schema.mjs`), **shared with #8800** (the mobile Resource Workbench) so
a desktop report and an on-device report line up column-for-column. It checks
the numbers against `budgets.json` and exits non-zero on regression.

## Honesty contract

No fabricated metrics, no always-pass stub:

- A modality row is `measured: true` **only** when a real load+run produced the
  numbers. Absent a model bundle or backend, the row is `measured: false` with a
  concrete `skipReason`, and the summary records exactly what was skipped.
- Numeric fields are `null` for an unmeasured row — never `0`. "Not measured" is
  never conflated with "zero".
- The co-residency block runs in `mode: "self-check"`: it drives the **real**
  `MemoryArbiter` (the production eviction policy + telemetry) with synthetic
  **sized** loaders, because the desktop engine loads one model at a time and
  cannot co-resident-load independent vision/voice backends. What is real is the
  arbiter's `eviction` telemetry — the fit-to-budget LRU path and the
  critical-pressure path both fire on these sizes and emit the events the harness
  counts. The `mode` label discloses this, the self-check can never satisfy the
  real-backend eviction ceiling (`maxEvictions`), and a broken telemetry path
  fails **loudly** (`selfCheckMinEvictions` asserts the arbiter counts ≥1
  eviction). The `mode: "real"` budget seam (`maxEvictions`) is reserved for a
  future real-backend co-residency path.

## Run

```bash
# Full harness + consolidated dashboard (results/summary/latest.md + .json)
bun run bench:memperf
node packages/benchmarks/memperf/run-all.mjs            # equivalent

# JSON to stdout
bun run bench:memperf:json

# The measuring harness directly (TS — imports the real plugin services):
bun --conditions=eliza-source packages/benchmarks/memperf/memperf-kpi.ts
bun --conditions=eliza-source packages/benchmarks/memperf/memperf-kpi.ts --json

# Limit to specific tiers / generation length:
MEMPERF_TIERS=eliza-1-2b,eliza-1-4b bun --conditions=eliza-source \
  packages/benchmarks/memperf/memperf-kpi.ts
MEMPERF_MAX_TOKENS=64 bun run bench:memperf
```

`--conditions=eliza-source` is required: the harness imports
`@elizaos/plugin-local-inference` source (the `MemoryArbiter`, the engine, the
hardware probe) under the `eliza-source` export condition.

## Exit codes (CI gate)

- `0` — measured rows present, all budgets pass.
- `1` — a budget (measured peak-RSS over ceiling, real co-residency eviction
  count over ceiling, or a broken arbiter-telemetry self-check) **FAILED**.
- `2` — nothing measurable on this host (no model bundle); the self-check ran
  and passed. This is the CI-without-GBs-of-models path: the harness runs
  cleanly and records what it skipped.

## Budgets

`budgets.json` carries per-tier `peakRssMb` (the resident ceiling for a
single-tier text load+run) and `coResidency.maxEvictions` (the ceiling for the
**real** co-residency sequence on a known-fitting set). `selfCheckMinEvictions`
is the floor the synthetic wiring self-check must hit to prove eviction
telemetry counts. Ratchet the per-tier ceilings down as the LRU fit-path and
dynamic context selection (#8809 steps 1/4) land.

## Layout

| Path | Role |
| --- | --- |
| `memperf-kpi.ts` | The measuring harness (TS; real arbiter + engine + probe) |
| `run-all.mjs` | Orchestrator: spawns the harness, writes `results/summary/` dashboard, propagates exit code |
| `metric-schema.mjs` | The `METRIC_SCHEMA` shared with #8800 + the skipped-row builder |
| `lib.mjs` | RSS sampling, result recording, git context, budget loader |
| `budgets.json` | Per-tier peak-RSS + co-residency eviction budgets |
| `metric-schema.test.ts` | Schema-contract tests (pins the shared field set) |
| `co-residency.test.ts` | Real-arbiter eviction-telemetry tests (fit + pressure) |
| `results/` | Timestamped JSON results (gitignored; only `.gitignore` committed) |

## Test

```bash
bun test --conditions=eliza-source packages/benchmarks/memperf/metric-schema.test.ts
bun test --conditions=eliza-source packages/benchmarks/memperf/co-residency.test.ts
```

`metric-schema.test.ts` pins the shared field set so a rename/drop is caught
(and must bump `METRIC_SCHEMA_VERSION`). `co-residency.test.ts` drives the real
`MemoryArbiter` with synthetic sized loaders and asserts the fit-path and the
critical-pressure path both emit the eviction telemetry the harness counts — no
models, no FFI, CI-safe everywhere.

## Relationship to #8800 / the iOS grind

The metric field set mirrors
`plugins/plugin-local-inference/docs/memory-and-e2e-latency-review.md` §5 and the
on-device iOS grind (`plugins/plugin-capacitor-bridge/src/ios/model-grind.ts`),
so the desktop harness, the iOS grind, and the #8800 mobile workbench all speak
the same metric language. This issue (#8809) owns the desktop/server harness +
the arbiter telemetry feed; #8800 owns the mobile surface and consumes the same
`METRIC_SCHEMA`.
