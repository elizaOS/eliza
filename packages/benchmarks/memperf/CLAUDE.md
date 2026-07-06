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
