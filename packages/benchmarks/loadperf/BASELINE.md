# Load / Perf Baseline

Reference measurements captured on `develop`. Re-run the KPIs (`run-all.mjs`) to
refresh; ratchet `budgets.json` down as these improve. All sizes are
**brotli**-compressed bytes.

Captured: 2026-05-31; **corrected 2026-06-02** (see CORRECTIONS below).

## CORRECTIONS (2026-06-02) — the original numbers below were wrong

Two of the original baseline numbers were measurement artifacts, not real:

1. **Bundle "2.33 MB duplicate-lib FAIL" was a stale watch-mode dist.** The
   measured `dist/` had three build generations layered together (Electrobun
   fast-dist leaves `emptyOutDir` off, so each rebuild appended). On a **clean
   `bun run --cwd packages/app build:web`** the bundle PASSES all budgets — see
   the corrected table immediately below. (research/01-frontend-bundle-load.md)
2. **Boot "70 ms readyMs PASS" was false.** `lib.mjs` treated any HTTP 200 with
   `ready===undefined` as ready, timing the API bind, not agent readiness.
   **Real cold boot ≈ 28.4 s (FAILS the 25 s budget)**, RSS ≈ 1272 MB (passes).
   Fixing the readiness gate (loadperf W5.0) is a prerequisite for trusting boot
   deltas. (research/03-agent-boot-plugins.md)

## Bundle (`bundle-kpi.mjs`) — CORRECTED, clean `build:web`, measured 2026-06-02

| Metric | Value | Budget | Status |
| --- | --- | --- | --- |
| total brotli | 3.75 MB | 15.6 MB | PASS |
| eager (first-paint) brotli | 1202.6 KB across 52 chunks | 1.43 MB | PASS |
| initial entry brotli | 1104.4 KB (`index-*.js`, 5.23 MB raw) | 2.25 MB | PASS |
| largest chunk brotli | 1104.4 KB (`index-*.js`) | 2.25 MB | PASS |
| duplicate-lib waste | 0.30 MB | 1.20 MB | PASS |

- total raw 17.44 MB; lazy (on-demand) 2636 KB brotli.
- Heavy chunks (mostly lazy): `phonemizer` 622.8 KB (1 chunk — already deduped),
  `mermaid` 205 KB, `three` family 330 KB across 4 chunks. These are NOT on the
  eager path; don't "fix" them as if they were.
- **Always measure a clean `build:web` output, never a watch-mode dist.**

### Original (WRONG — stale watch-mode dist), kept for the record
initial entry 706 KB · total 6.93 MB · "duplicate-lib waste 2.33 MB FAIL" —
all artifacts of measuring a 3-generation layered watch dist; disregard.

## Boot (`boot-kpi.mjs`) — CORRECTED

- **Real cold readyMs ≈ 28.4 s (median; runs 23 s / 28 s / >33 s under load) —
  FAILS the 25 000 ms budget.** Peak RSS ≈ 1272 MB (passes 1600 MB).
- The original "70 ms PASS" was a false positive from the permissive readiness
  check. Budgets: cold `readyMs` ≤ 25 000, peak RSS ≤ 1600 MB.
- **Harness is now honest (loadperf F1 + F8).** The boot KPI:
  - requires an explicit `health.ready === true` from `/api/health` — a bare
    HTTP 200 (stale server / early-liveness handler) no longer counts as ready,
    so the old "70 ms" artifact is impossible. `waitForReady` (lib.mjs) is the
    single gate; it has no loose opt-in because `boot-kpi.mjs` is its only caller.
  - **fails the run** (exit 1) unless the final probe returned `ready === true`
    AND the median `readyMs` is at/above the sanity floor (3000 ms) — a
    sub-second "boot" is physically impossible and means a false-positive read.
  - **runs N cold boots (default 3; `--runs=N` or `LOADPERF_BOOT_RUNS`)** and
    checks the **median** against budget, reporting **median / p95 / min / max**
    and the per-run list so a single noisy sample can't be read as a real delta.
  - prints a **WARN** when the host is under heavy CPU contention (loadavg over
    cpu count, or more sibling node/bun/tsx procs than cpus) — boot is
    single-threaded and import-bound, so a contended run inflates readyMs with no
    code regression. `summary.contention` (loadavg, cpu count, sibling count) is
    recorded for every run.

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
