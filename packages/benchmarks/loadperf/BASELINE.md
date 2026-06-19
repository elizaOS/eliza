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

- **The KPI now measures the SHIPPED binary** (`bun run dist/entry.js start`,
  what the desktop/mobile app spawns), not the tsx dev-server. The old ~28 s
  "FAIL" was the **dev path** — it counted a ~2 s on-the-fly tsx transpile +
  dev-only orchestration that production never pays. `--dev` reproduces it.
- **Real production cold readyMs ≈ 4.6 s** (built `entry.js start`, fresh dist,
  `ELIZA_DEFER_APP_ROUTES=1` as the desktop launcher sets) — **PASSES** the
  25 000 ms budget with wide margin; peak RSS ≈ 1264 MB. Boot is a ~1 s blocking
  phase + the deferred plugin wave running off the critical path (the
  deferred-kickoff decoupling in agent eliza.ts).
- A stale-dist + heavily-contended reading was ~34.8 s; rebuilding with the
  deferred-kickoff fix dropped it to ~4.6 s — most of the old number was the
  missing fix + CPU contention (now WARNed), not real work.
- Dev (tsx) path, for reference: best ~3.1 s, ~12 s under contention.
- The original "70 ms PASS" was a false positive from the permissive readiness
  check. Budgets: cold `readyMs` ≤ 25 000, peak RSS ≤ 1600 MB.

### Boot profile (quiesced, `ELIZA_BOOT_PROFILE=1`)

Boot `bun run dist/entry.js start` with `ELIZA_BOOT_PROFILE=1` to print `[boot-profile]`
laps (the gated profiler in `app-core/src/boot-profile.ts` + `agent/src/api/server.ts`).
Spawn → `ready:true` on a quiet host (~3.7 s) decomposes as:

| Segment | ~cost | Notes |
| --- | --- | --- |
| Bun load of `entry.js` + `@elizaos/shared` | 310 ms | built JS; NOT a transpile |
| CLI program build + dispatch | 150 ms | commander |
| `startApiServer` (bind) | 500–760 ms | route-module imports + middleware ~470 ms, then `listen` |
| Runtime boot (`upstreamStartEliza` + `repairRuntimeAfterBoot`) | **1960 ms** | dominant; blocking-plugin imports ~1.1 s (sql/local-inference) + sql-compat/local-inference/autonomy wiring |

- **The runtime boot dominates** (~2 s) and is mostly load-bearing work
  (blocking plugins, SQL compat, autonomy). The earlier "module load is the ~4 s
  cost" hypothesis was wrong — Bun loads the built graph in ~310 ms.
- With the **server-only early API bind**, `/api/health` is reachable at
  ~1.3 s (`agentState:"starting"`) — the webview connects + hydrates in parallel
  with the remaining ~2.4 s of runtime boot instead of waiting for it.
- Remaining levers (defer blocking-plugin imports, lazy non-first-paint route
  modules) are runtime-essential / architecture-sensitive — profile each before
  touching; the boot already passes budget ~6×.
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
