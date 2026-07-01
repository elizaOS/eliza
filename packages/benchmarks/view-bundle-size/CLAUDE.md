# view-bundle-size — Agent Guide

Device-independent, deterministic **bundle-size regression gate** for the plugin
**view bundles** (issue #10724). Builds every plugin's view bundle via the
existing `bun run build:views` build (the same one the view-bundle import guard
relies on), sums the **gzipped** (and raw) bytes of each emitted
`plugins/<name>/dist/views/*.js|css`, compares each bundle plus the total against
the committed ceilings in `budgets.json`, prints a table, and exits non-zero on
regression. No models, no hardware, no live model, no server. Not registered in
the suite orchestrator — run directly with `node`.

Complements `loadperf/bundle-kpi.mjs` (which gates the assembled **web app**
dist, `packages/app/dist`, in brotli). This gate covers the per-plugin **view
bundles**, which had no size gate before.

## Run

```bash
# Build the view bundles + gate + consolidated dashboard (results/summary/latest.md)
bun run check:view-bundle-size
node packages/benchmarks/view-bundle-size/run-all.mjs        # equivalent
bun run check:view-bundle-size:json                          # JSON to stdout

# The gate harness directly:
node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs
node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs --json

# Measure an ALREADY-built dist (CI builds in a prior step, then gates):
bun run build:views
node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs --no-build
```

## Smoke test (no build)

```bash
# With no view bundle built, every row skips and the gate exits 2 (skip) —
# never a fabricated pass. Runs anywhere.
node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs --no-build
```

## Test the harness

```bash
bun test packages/benchmarks/view-bundle-size/metric-schema.test.ts

# Typecheck (this harness is not a workspace package; use its standalone config):
node_modules/.bin/tsgo --noEmit -p packages/benchmarks/view-bundle-size/tsconfig.check.json
```

`metric-schema.test.ts` pins the per-bundle field set AND the **null-not-zero**
honesty contract in the budget comparator — a bundle that did not build
(`measured:false`, `gzipBytes:null`) can never satisfy a budget, no matter how
generous.

## Layout

| Path | Role |
| --- | --- |
| `bundle-size-kpi.mjs` | Gate: build view bundles → measure gzip/raw → compare to budgets → table → exit 0/1/2 |
| `run-all.mjs` | Orchestrator: spawns the gate, writes the dashboard, propagates the exit code |
| `metric-schema.mjs` | Per-bundle row shape + the budget comparator (honesty contract) |
| `lib.mjs` | Bundle discovery + gzip/raw measurement, result recording, git context |
| `budgets.json` | Per-bundle gzip ceilings + total ceiling + the measured baseline |
| `metric-schema.test.ts` | Schema + comparator (null-not-zero) tests |
| `tsconfig.check.json` | Standalone typecheck config |
| `results/` | Timestamped JSON results (gitignored; only `.gitignore` committed) |

## Notes / gotchas

- **Exit codes:** `0` pass, `1` a bundle/total over budget (regression), `2`
  nothing measurable (no view bundle built) — usable directly as a CI gate. The
  `.github/workflows/view-bundle-size.yml` lane builds the bundles then runs the
  gate with `--no-build` and gates on the exit code.
- **Honesty contract.** A bundle that fails to build is `measured:false` with
  sizes `null` (never `0`) and never satisfies a budget. When the build works
  (some bundle built) but a *budgeted* bundle produced nothing, that is a failing
  check (a real regression), not a silent skip.
- **Gzip level 9, pinned** (`GZIP_LEVEL` in `lib.mjs`) so budgets stay
  apples-to-apples. Budgets are gzipped bytes; raw bytes are recorded for context
  but not gated.
- **Budgets = measured baseline + ~10–15% headroom.** The baseline was captured
  from a local build of `origin/develop`; CI re-confirms on ubuntu. Ratchet
  `gzipBudgetBytes` **down** as views shrink — monotonic improvement is the goal.
- A new plugin view with no budget entry is reported (and folded into the total)
  but not per-bundle gated; add a `budgets.json` entry for it.
- Full overview: [README.md](README.md).
