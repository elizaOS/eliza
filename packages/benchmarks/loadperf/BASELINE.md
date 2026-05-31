# Load / Perf Baseline

Reference measurements captured on `develop`. Re-run the KPIs (`run-all.mjs`) to
refresh; ratchet `budgets.json` down as these improve. All sizes are
**brotli**-compressed bytes.

Captured: 2026-05-31 (commit on `develop`).

## Bundle (`bundle-kpi.mjs`) — measured

Build under test: `packages/app/dist` (316 JS/CSS assets).

| Metric | Value | Budget | Status |
| --- | --- | --- | --- |
| initial entry brotli | 706 KB (`index-*.js`) | 2.30 MB | PASS |
| total assets brotli | 6.93 MB | 16.0 MB | PASS |
| largest chunk brotli | 706 KB (`index-*.js`) | 2.30 MB | PASS |
| duplicate-lib waste | **2.33 MB** | 1.20 MB | **FAIL** |

- total raw: 37.3 MB across 316 files
- The **duplicate-lib budget is the one failing check**: the same logical chunks
  are emitted once per entry point, wasting ~2.33 MB brotli in redundant copies.
- Heavy single-file chunks: `phonemizer-*.js` (~671 KB brotli), the `index-*`
  app chunk (~706 KB brotli), plus the `three` family spread across multiple
  chunk names.

## Boot (`boot-kpi.mjs`) — skipped this run

- Status: **skipped** — the headless `dev-server` exited early during the
  capture window (a concurrent process was rewriting `packages/app-core/**` at
  the time). Re-run on a quiet checkout:
  `node packages/benchmarks/loadperf/boot-kpi.mjs`
- Budgets: cold `readyMs` ≤ 25 000, peak RSS ≤ 1600 MB.

## Frontend (`frontend-kpi.mjs`) — skipped this run

- Status: **skipped** — `playwright` is installed but no browser binary is
  present. Install one and re-run:
  `bunx playwright install chromium` then
  `node packages/benchmarks/loadperf/frontend-kpi.mjs`
- Budgets: FCP ≤ 2500 ms, LCP ≤ 4000 ms, JS transferred ≤ 3.5 MB, requests
  ≤ 120, long tasks ≤ 2000 ms.

## State-sync (`statesync-kpi.mjs`) — not run

- Requires a live WebSocket server (`LOADPERF_BASE_URL` / `LOADPERF_WS_URL`).
- Budgets: broadcast skew p95 ≤ 400 ms, reconnect ≤ 6000 ms, desync events 0.

## Top optimization targets

1. **Kill duplicate chunks (~2.33 MB brotli wasted).** The bundle ships the same
   logical chunks once per entry point. Consolidating to shared/lazy chunks (a
   single `manualChunks` strategy or a shared vendor split) reclaims the largest
   single win and clears the only failing budget.
2. **Split / lazy-load the `phonemizer` chunk (~671 KB brotli).** It is eagerly
   present; gate it behind the voice feature so it loads on demand.
3. **De-duplicate the `three` family.** Three.js appears under several chunk
   names — pin a single import path so it is emitted once.
4. **Trim the `index-*` entry/app chunk (~706 KB brotli).** Route-level code
   splitting moves non-initial routes out of the eager entry.
