# view-bundle-size

A device-independent, deterministic **bundle-size regression guardrail** for the
elizaOS plugin **view bundles** — the memory/CPU/battery-optimization work item
"budgets/CI checks for bundle size, so regressions fail the build" (issue
#10724).

## What it measures

Each plugin that ships an in-app view declares `vite.config.views.ts` and builds
a self-contained ES bundle to `plugins/<name>/dist/views/` (host singletons like
`@elizaos/ui`, `react`, `@elizaos/shared` are left **external**, so they are not
counted). This gate:

1. **Builds** every view bundle via `bun run build:views` (the existing
   view-bundle vite build the import guard already relies on).
2. **Measures** the **gzipped** and raw bytes of each emitted `dist/views/*.js`
   and `*.css` (sourcemaps excluded — they do not ship). Gzip level is pinned
   (level 9) so the numbers are deterministic run-to-run.
3. **Compares** each bundle plus the summed total against the committed ceilings
   in [`budgets.json`](./budgets.json).
4. **Exits** `0` (all under budget) / `1` (a bundle or the total regressed) /
   `2` (nothing measurable — no bundle built).

Gzip is the meaningful "over the wire" budget unit; raw bytes are recorded for
context but not gated.

## Why it exists / how it fits

`loadperf/bundle-kpi.mjs` already gates the assembled **web app** dist
(`packages/app/dist`) in brotli, but nothing gated the **per-plugin view
bundles** — a view could balloon (a heavy chart lib, an un-tree-shaken import, a
3D dependency pulled into the graph) and ship with no signal. This gate closes
that gap and turns a size regression red in CI.

## Baseline (origin/develop, gzip level 9)

26 view bundles, **265.9 kB gzip** total (1.14 MB raw). Largest:
`plugin-task-coordinator` (~124 kB gzip — bundles xterm), `plugin-training`
(~30 kB), `plugin-wallet-ui` (~16 kB). Per-bundle ceilings are the measured size
plus ~10–15% headroom; see `budgets.json` (`measuredGzipBytes` is recorded next
to each `gzipBudgetBytes` for ratcheting).

## Usage

```bash
bun run check:view-bundle-size          # build + gate + dashboard
bun run check:view-bundle-size:json     # JSON to stdout

# CI-style (build once, then gate the built dist):
bun run build:views
node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs --no-build
```

Exit codes are usable directly as a CI gate; the
`.github/workflows/view-bundle-size.yml` lane wires them.

## Honesty contract

A bundle that fails to build is `measured: false` with sizes `null` — **never
`0`** — and can never satisfy a budget (`null` is not `<=` any ceiling). When the
build otherwise works but a *budgeted* bundle produced nothing, that is a failing
check (a real regression), not a silent skip. When *nothing* builds, the gate
skips (exit 2) rather than fabricating a pass. This contract is pinned by
`metric-schema.test.ts`.

## Files

See [`AGENTS.md`](./AGENTS.md) for the per-file layout, the smoke test, the
harness test command, and the standalone typecheck config.
