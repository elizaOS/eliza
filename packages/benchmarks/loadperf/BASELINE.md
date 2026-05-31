# Load / Perf Baseline

Reference measurements captured on `develop`. Re-run the KPIs (`run-all.mjs`) to
refresh; ratchet `budgets.json` down as these improve. All bundle sizes are
**brotli**-compressed bytes.

Captured: 2026-05-31. Note: the checkout was being actively rebuilt by a
concurrent process during capture, so absolute numbers will drift slightly
between runs — treat these as a snapshot, not a contract.

## Bundle (`bundle-kpi.mjs`) — measured, FAIL

Build under test: `packages/app/dist` (316 JS/CSS assets).

| Metric | Value | Budget | Status |
| --- | --- | --- | --- |
| initial entry brotli | 912 KB (`index-*.js`) | 2.30 MB | PASS |
| total assets brotli | 6.94 MB | 16.0 MB | PASS |
| largest chunk brotli | 912 KB (`index-*.js`) | 2.30 MB | PASS |
| max duplicate-lib waste | **1.20 MB** (`index` x43) | 1.20 MB | **FAIL** |

- total raw: 37.4 MB across 316 files; total duplicate waste across all logical
  chunks: ~3.04 MB brotli.
- **The failing check is `maxDuplicateLibBytes`**: the `index` logical chunk is
  emitted 43 times (once per entry/route), wasting ~1.20 MB brotli — just over
  budget.
- Heavy single chunks: `phonemizer` (~1.31 MB brotli across 2 copies),
  `index` app chunk (~912 KB), `three` family (~845 KB across 5 chunk names),
  `lucide-react` (~241 KB).

## Boot (`boot-kpi.mjs`) — measured, FAIL

Spawned headless `dev-server` (`ELIZA_HEADLESS=1`), polled `/api/health`.

| Metric | Value | Budget | Status |
| --- | --- | --- | --- |
| cold readyMs | 23 385 ms | 25 000 ms | PASS |
| peak RSS | **1 754 MB** | 1 600 MB | **FAIL** |

- Cold boot is just under the 25 s budget; **peak RSS (~1.75 GB) exceeds the
  1.6 GB budget**. Captured while a concurrent build was competing for the host,
  which inflates both numbers — re-run on a quiet checkout for a clean reading.

## Frontend (`frontend-kpi.mjs`) — measured, FAIL

Served `packages/app/dist` as a static SPA, driven in headless Chromium
(`--no-sandbox`).

| Metric | Value | Budget | Status |
| --- | --- | --- | --- |
| FCP | 2 840 ms | 2 500 ms | **FAIL** |
| LCP | 5 340 ms | 4 000 ms | **FAIL** |
| CLS | 0.011 | — | — |
| TTFB | ~3 ms | — | — |
| load | ~209 ms | — | — |
| JS transferred | **10.9 MB** | 3.5 MB | **FAIL** |
| requests | 104 | 120 | PASS |
| long tasks | 2 991 ms | 2 000 ms | **FAIL** |

- **JS transferred (~10.9 MB) is ~3x over budget** — the dominant problem. FCP,
  LCP, and long-task time all fail as a direct consequence of shipping/parsing
  that much eager JS.

## State-sync (`statesync-kpi.mjs`) — not run

- Requires a live WebSocket server (`LOADPERF_BASE_URL` / `LOADPERF_WS_URL`).
- Budgets: broadcast skew p95 ≤ 400 ms, reconnect ≤ 6000 ms, desync events 0.
- Run against a booted agent:
  `LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/statesync-kpi.mjs`

## Top optimization targets

1. **Cut eager JS transferred (~10.9 MB → < 3.5 MB).** This is the single
   biggest lever: it drives the frontend FCP/LCP/long-task failures. Route-level
   code splitting + lazy-loading non-initial views.
2. **Eliminate the `index` chunk duplication (43 copies, ~1.20 MB waste).** A
   shared/common-chunk strategy so the app shell is emitted once, not per route —
   clears the failing bundle budget.
3. **Lazy-load `phonemizer` (~1.31 MB brotli, 2 copies).** Gate it behind the
   voice feature so it loads on demand instead of eagerly.
4. **De-duplicate the `three` family (5 chunk names, ~845 KB).** Pin a single
   import path so three.js is emitted once.
5. **Reduce boot peak RSS (~1.75 GB → < 1.6 GB).** Re-measure on a quiet host
   first; if it holds, profile the headless runtime's import/eval footprint.
