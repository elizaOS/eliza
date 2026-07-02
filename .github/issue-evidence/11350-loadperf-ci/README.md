# #11350 Loadperf Bundle Gate Evidence

Captured on Windows 11 in worktree
`C:\Users\Administrator\.codex\worktrees\4a18\eliza` on 2026-07-02.

## What Changed

- Added root `check:loadperf-bundle` and `check:loadperf-bundle:json` scripts.
- Wired `test:client` to run `check:loadperf-bundle` before the existing client
  test orchestrator. The develop `test.yml` client lane already runs for
  `packages/app/**` and `packages/ui/**` through `ci-path-gate.mjs`, so app/UI
  bundle regressions now get a PR-blocking budget signal without requiring a
  workflow-file change.
- `bundle-kpi.mjs` now exits `2` when a dist has no HTML/module entry instead
  of treating worker-only assets as a passing bundle measurement.
- `budgets.json` and `BASELINE.md` were re-baselined to the current clean
  `develop` bundle (`858548c0d6`) so the new gate starts green and blocks
  future growth, then rebased after #11471 and ratcheted to a 3.4 MB eager
  budget using #11471's measured 3107.1 KB post-lazy-load eager graph.
- A standalone `.github/workflows/loadperf.yml` was authored and locally
  validated, but this Windows credential cannot push workflow files because its
  `GH_TOKEN` lacks the GitHub `workflow` scope. The push was rejected by GitHub,
  so the PR uses the existing develop client-test lane instead.

## Commands Run

```bash
bun run --cwd packages/shared build:i18n
bun run --cwd packages/app prebuild
bun run --cwd packages/app build:web
node packages/benchmarks/loadperf/bundle-kpi.mjs
bun run check:loadperf-bundle
node --check packages/benchmarks/loadperf/bundle-kpi.mjs
bunx biome check package.json packages/benchmarks/loadperf/bundle-kpi.mjs packages/benchmarks/loadperf/budgets.json
git diff --check
```

## Results

- `build:web`: passed; Vite built 10,796 modules in 4m34s and
  `verify-chunk-safety` passed both checks.
- `bun run check:loadperf-bundle`: passed; generated i18n, synced app assets,
  rebuilt the web bundle, passed `verify-chunk-safety`, and then passed
  `bundle-kpi`.
- Old budgets on the same clean dist: `bundle-kpi` recorded `pass:false`.
  Failed checks were `initialEntryBrotli` (`3,153,863 > 2,300,000`) and
  `eagerGraphBrotli` (`3,320,289 > 1,500,000`).
- Updated budgets: `bundle-kpi` passed.
  - asset count: 356 JS/CSS files
  - total brotli: 5,196,347 bytes
  - initial entry brotli: 3,153,863 bytes
  - eager graph brotli: 3,320,289 bytes
  - largest chunk brotli: 1,391,668 bytes
  - max duplicate lib bytes: 225,101 bytes
- Post-#11471 rebase: kept the tightened #11350 budget set, but resolved the
  `eagerGraphBrotliBytes` conflict to 3,400,000 bytes. #11471 measured the
  merged lazy-load path at 3,107.1 KB eager brotli; its committed 1,374,505 byte
  budget came from the older pre-regression baseline and would make the current
  app fail once this gate runs in CI.
- `node --check`: passed.
- focused Biome check: passed.
- `git diff --check`: passed.
- Push with standalone `.github/workflows/loadperf.yml`: rejected by GitHub
  because the current token has `repo` but not `workflow` scope.

## N/A

Screenshots and screen recording are N/A for this slice: it only wires a CI
script gate and benchmark script behavior, with no UI/runtime visual surface
changed.
