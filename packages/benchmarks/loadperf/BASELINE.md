# Load / Perf Baseline

Reference measurements captured on `develop`. Re-run the KPIs (`run-all.mjs`) to
refresh; ratchet `budgets.json` down as these improve. All sizes are
**brotli**-compressed bytes.

Captured: 2026-05-31; **corrected 2026-06-02** (see CORRECTIONS below);
**re-baselined 2026-07-02** for the #11350 CI gate;
**ratcheted 2026-07-02** by the #11351 residual lazy-loads (see below).

## CURRENT CI GATE BASELINE (2026-07-02) — clean `build:web`

Measured on `origin/develop` `858548c0d6` after a clean
`bun run --cwd packages/app build:web`, then
`node packages/benchmarks/loadperf/bundle-kpi.mjs`. Rebased after #11471
(`34e839184b`), which measured the same build path at 3107.1 KB eager brotli;
the CI budget was ratcheted from 3550.0 KB to 3400.0 KB to keep that win
without using #11471's stale 1374.5 KB pre-regression budget.

| Metric | Value | Gate budget | Status |
| --- | --- | --- | --- |
| total brotli | 4.96 MB | 6.00 MB | PASS |
| eager (first-paint) brotli | 3242.5 KB across 34 chunks; #11471 after: 3107.1 KB | 3400.0 KB | PASS |
| initial entry brotli | 3079.9 KB (`index-*`, `vendor-crypto-*`, `vendor-three-*`, `vendor-react-*`, `vendor-lucide-*`) | 3350.0 KB | PASS |
| largest chunk brotli | 1359.2 KB (`index-*.js`) | 1600.0 KB | PASS |
| duplicate-lib waste | 251.3 KB total, 219.8 KB max logical duplicate | 350.0 KB max | PASS |

The 2026-07-02 app is heavier on the eager path than the 2026-06-02 corrected
baseline because `vendor-crypto-*` and `vendor-three-*` are currently loaded as
initial entries. #11350 establishes a green CI gate at the current reality so
future regressions are blocked; #11471 moved 122.6 KB off the eager path and
the gate preserves that ratchet. Follow-up optimization should split/lazy-load
remaining eager vendors and ratchet `budgets.json` back down.

### #11351 residual lazy-loads (2026-07-02) — measured ratchet

The #11471 review found two static eager paths that partially defeated its
lazy split: `DetachedShellRoot` (statically imported by the eager entry for
detached windows) pulled nine views (ProviderSwitcher, PermissionsSection,
ReleaseCenterView, ConfigPageView, VoiceConfigView, CloudDashboard,
HeartbeatsView, ChatView, ConversationsSidebar) into every window's
first-paint graph, and `App.tsx` statically imported the whole vault surface
via `SecretsManagerModalRoot`. Both are now lazy (the vault modal loads on
first open; its open/close event subscription stays eager so no dispatch is
missed).

Measured on this branch's rebase base (`0140a4fcb9e`) vs the change — clean
`build:web` both sides, same machine (macOS arm64):

| Metric | Before (develop base) | After (#11351 residuals) | Gate budget | Status |
| --- | --- | --- | --- | --- |
| eager (first-paint) brotli | 3,210,097 B (3135.0 KB / 39 chunks) | **3,142,732 B** (3069.1 KB / 57 chunks) | 3,330,000 B | PASS |
| initial entry brotli | 3,024,127 B (2953.2 KB) | **2,937,470 B** (2868.6 KB) | 3,260,000 B | PASS |
| total brotli | 5,233,041 B | 5,268,874 B (+35 KB chunk-split overhead) | 6,000,000 B | PASS |

Delta: **eager −67,365 B (−65.8 KB), entry −86,657 B (−84.6 KB)**; 29 new
on-demand chunks (379 → 408 assets). Budgets ratcheted down by (slightly more
than) the realized saving: `eagerGraphBrotliBytes` 3,400,000 → **3,330,000**,
`initialEntryBrotliBytes` 3,350,000 → **3,260,000**. Against the CI-measured
base (3,320,289 B eager), the expected CI after ≈ 3,252,900 B keeps ~2.3%
headroom under the new gate. (Local absolute values sit ~110 KB under CI's —
machine variance; the delta is the trustworthy number.)

### `maxDuplicateLibBytes` remeasured (2026-07-03) — content-based, ratcheted 350 KB → 25 KB

The duplicate detector originally grouped chunks by hash-stripped **basename**,
which conflated unrelated modules that legitimately share generic names —
every npm package entry emits an `index-*.js` chunk, every view emits a
`register-terminal-view-*.js` chunk, and so on. That noise floor (~340 KB, and
higher on dev machines with extra postinstall plugin HTML entries) sat just
under the 350 KB budget and finally crossed it as ordinary `index.ts`-named
lazy chunks accumulated (380.6 KB at `a747ced409`), failing the gate with zero
actual duplication: content-hashing the same dist (rollup hash references
stripped, so per-entry copies that differ only in hashed sibling-chunk names
still match) found **67 bytes** of true duplicate waste — two identical tiny
chunks. The detector now groups by normalized content, and the budget is
ratcheted 350,000 → **25,000** bytes, so a single duplicated vendor library
(the regression this gate exists to catch) trips it immediately instead of
hiding inside a ±30 KB name-collision noise band.

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

## Bundle (`bundle-kpi.mjs`) — SUPERSEDED 2026-07-02 (kept for the record), measured 2026-06-02

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

### Steady-state RSS (idle resident cost — new)

`peakRssMb` is the boot-time high-water mark; a booted agent that never releases
boot scratch (or slowly grows at idle) is a **separate** regression class the
peak number hides. After `ready`, the KPI now holds the idle process for a
settle window (`LOADPERF_STEADY_SETTLE_MS`, default 12 s), samples `/proc` VmRSS,
and reports **`steadyRssMb`** = the median of the window's tail (last 60 %), the
resident cost the headless keyless agent actually carries once boot churn
subsides.

- **Measured** (prod `entry.js start`, keyless/headless, `--runs=2`, 12 s settle,
  on a heavily CPU-contended host — RSS is contention-insensitive): peak RSS
  **1057.6 MB**, **steady RSS 1069 MB**. Steady sits slightly *above* boot-peak
  because RSS keeps climbing during post-ready warmup (lazy provider/embedding
  load, GC not yet run) — the exact resident tail the boot-peak sample misses.
- **Budget: `steadyRssMb` ≤ 1500 MB** — ~40 % headroom over the measured 1069 MB
  and above the historical ~1272 MB peak reading, so it catches a real resident
  regression (a ~430 MB idle leak) without flaking on host variance. Ratchet it
  down as idle-footprint optimizations land. A `null` budget records the number
  without gating; `--attach` mode reports `null` (no child pid to sample).

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

### Boot-KPI CI gate — now ENFORCING (item 5 of #8812)

The build-agent-image workflow's boot-verify step
(`docker-ci-smoke.sh --boot-verify-only`) now runs with `BOOT_KPI_ENFORCE=1`, so
a cold-start `readyMs` that exceeds `boot.coldReadyMs` (25 000 ms) **fails the
build** and blocks publishing a slow image — the server/container analog of the
mobile resource workbench (#8800). Safety rails so the gate is trustworthy, not
flaky:

- The budget keeps ~5× headroom over the ~4.6 s real production cold boot, so
  only a genuine multi-× regression trips it.
- `emit_boot_kpi` logs the runner `loadavg(1m)`/cpu count next to `readyMs`, and
  **downgrades a breach to a warning** (does not fail) when the runner is heavily
  contended (loadavg(1m) > 2× cpus) — boot is single-threaded and import-bound,
  so a contended runner inflates `readyMs` with no code regression.
- `peakRssMb` is **not** enforced on the docker path: `docker stats` samples
  instantaneously, not the boot peak. Peak RSS is gated by the standalone
  `boot-kpi.mjs` (`/proc/<pid>/status` VmRSS, budget 1600 MB) when run on a host.

**Ratcheting the budget down requires a quiesced host re-baseline** — run
`node packages/benchmarks/loadperf/boot-kpi.mjs --runs=5 --json` with no sibling
node/bun/tsx load and update `boot.coldReadyMs` to the measured median + margin.
Do not ratchet from a contended reading (the harness WARNs when it detects one).

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
