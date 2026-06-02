# Load/Perf Verification Protocol

The contract for **every** performance change in this effort: measure a real
before, apply the change, measure a real after, and prove the app still works
end-to-end. No optimization is "done" until it has (a) a measured before/after
delta from a KPI in this harness and (b) a green correctness gate.

This file is the source of truth for *how we verify*. The per-area research
reports live in `research/`; the measured numbers live in `results/` and
`BASELINE.md`.

---

## 0. Environment facts (verified 2026-06-01)

- **Chromium IS available** for Playwright: `~/.cache/ms-playwright/chromium-1223`
  + `chromium_headless_shell-1223`, and `/usr/bin/google-chrome` exists. The
  frontend web-vitals KPI and the e2e correctness gate can both run here. (The
  old `BASELINE.md` note "no browser binary" is stale.)
- node `v25.2.1`, bun `1.3.14`, `tsx` present at `node_modules/.bin/tsx`.
- **This repo has concurrent actors** (multiple swarms build/edit on `develop`).
  A build can rewrite `packages/app/dist` underneath a measurement. ALWAYS
  measure against a *finished, stable* build, on a quiet checkout. `bundle-kpi`
  exits `2` ("skipped") if it sees the dist mutate mid-scan — re-run when quiet.

---

## 1. The four measured dimensions (the "before/after" numbers)

Each KPI is a standalone script under `packages/benchmarks/loadperf/`. Exit
codes: `0` pass, `1` budget failure, `2` skipped/unavailable. Real numbers only —
never estimate a delta you did not measure with one of these.

| Dimension | Command | Captures | Needs |
| --- | --- | --- | --- |
| **bundle** | `node packages/benchmarks/loadperf/bundle-kpi.mjs` | initial-entry brotli, total brotli, largest chunk, duplicate-lib waste, heavy-lib spread, per-chunk offenders | a finished `packages/app/dist` |
| **boot** | `node packages/benchmarks/loadperf/boot-kpi.mjs` | cold `readyMs`, peak RSS (spawns headless dev-server, polls `/api/health`) | nothing (or `--attach` to a running server) |
| **frontend** | `node packages/benchmarks/loadperf/frontend-kpi.mjs` | FCP, LCP, CLS, TTI, JS transferred, request count, long-task time | chromium (present) |
| **statesync** | `LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/statesync-kpi.mjs` | ws broadcast skew p50/p95, desync events, reconnect time | a live ws server |

`run-all.mjs` runs them together and writes `results/summary/latest.md`.

Budgets live in `budgets.json`. **Ratchet budgets DOWN** as wins land so a future
change can never silently regress them (monotonic improvement).

---

## 2. The before/after procedure (per optimization)

Do this for each landed optimization, recording numbers in the change's commit
message and (for milestones) `BASELINE.md`:

1. **Quiesce.** Confirm no concurrent build is rewriting `dist`
   (`ps aux | grep -E 'vite|rollup|build\.mjs'`). Measurements during a build
   are invalid.
2. **Capture BEFORE.** On the pre-change tree, build once and run the KPI(s) the
   change targets:
   ```bash
   bun run --cwd packages/app build          # only for bundle/frontend dims
   node packages/benchmarks/loadperf/run-all.mjs   # or the specific KPI
   ```
   Copy `results/<kpi>/latest.json` somewhere stable (it is timestamped too).
3. **Apply** the optimization.
4. **Capture AFTER.** Rebuild (if a build-affecting change) and re-run the SAME
   KPI(s) the SAME way.
5. **Diff.** Report the real delta (e.g. "initial entry 706 KB → 612 KB brotli,
   −94 KB / −13.3%"). If the dim has no movement, say so — do not claim a win you
   can't measure.
6. **Gate.** Run the correctness gate (section 3). A perf win that breaks a gate
   is a regression, not a win.
7. **Ratchet.** If the win is permanent, lower the relevant `budgets.json` key to
   just above the new value so it locks in.

> Boot and frontend numbers vary run-to-run (CPU contention, JIT warmup). Take
> the **median of 3 runs** for boot `readyMs` and frontend FCP/LCP before
> claiming a delta, and only claim deltas larger than run-to-run noise (rule of
> thumb: >5% and outside the min/max spread of the 3 baseline runs).

---

## 3. The correctness gate — "it still works end to end"

The user's hard requirement: **pages load, the agent responds to chats, views
switch, and view-dependent actions (loaded from plugins) fire.** These map to
existing Playwright ui-smoke specs that boot a live stack
(`packages/app-core/scripts/playwright-ui-live-stack.ts`, UI :2138 / API :31337).

Run from `packages/app`:
```bash
bun run --cwd packages/app test:e2e            # full ui-smoke suite
# or a targeted subset by spec file (see config: playwright.ui-smoke.config.ts)
ELIZA_UI_SMOKE_REUSE_SERVER=1 \
  bunx playwright test -c packages/app/playwright.ui-smoke.config.ts <spec>
```

> Cold start builds the renderer (~3000 modules, up to ~12 min) before the stack
> binds :2138; the config allows up to 20 min. Use `ELIZA_UI_SMOKE_REUSE_SERVER=1`
> against an already-running stack to skip the rebuild between runs.

**The gate = these specs must stay green across an optimization:**

| Requirement | Spec(s) | Asserts |
| --- | --- | --- |
| Pages load | `ui-smoke.spec.ts`, `all-pages-clicksafe.spec.ts`, `test/route-coverage.test.ts` | every route mounts without crash; chat composer ready signal `[data-testid="chat-composer-textarea"]` appears |
| Agent responds to chat | `live-agent-chat.spec.ts`, `assistant-home-flow.spec.ts` | a sent message yields an agent response |
| View switching | `view-manager-actual-flow.spec.ts`, `plugin-views-visual.spec.ts` | navigating between plugin/builtin views mounts the right surface |
| View-dependent actions | `test/view-interaction-coverage.test.ts`, `terminal-plugin-view-command-contract.spec.ts`, `*-gui-interactions.spec.ts` | view capabilities/actions dispatch and take effect |
| Multi-window sync | `multi-window-sync.spec.ts`, `multi-client-desync.spec.ts` | cross-tab/client state stays consistent (some `test.fixme` pending live shared backend) |
| Perf web-vitals | `perf-load-kpi.spec.ts` | FCP/LCP/JS-payload within soft budgets on `/chat` (doubles as a measurement) |

**Minimum gate for any single optimization** (fast signal):
`ui-smoke.spec.ts` + `live-agent-chat.spec.ts` + `view-manager-actual-flow.spec.ts`
+ `perf-load-kpi.spec.ts`.
**Full gate before declaring the effort done:** the entire `test:e2e` suite plus
`bun run --cwd packages/app typecheck` and `bun run verify`.

---

## 4. Per-area instrumentation the research reports may add

Some dimensions need instrumentation the harness doesn't have yet. When a report
proposes one, it must specify the exact command + pass/fail threshold. Expected
additions (tracked, not yet built):

- **React render-count harness** — count component commits during a scripted
  chat+view-switch interaction (before/after re-render reduction). Owner: report 02.
- **Core CPU/heap micro-benchmark** — process N messages headless under
  `--cpu-prof` / `--heap-prof`; report CPU ms + heap delta. Owner: report 04.
- **Cache hit/miss counters** — instrument each server/runtime cache; report hit
  rate over a scripted workload. Owners: reports 04, 06.
- **Server route latency + DB query counter** — middleware timing + adapter wrap;
  p50/p95 latency + query count per route over a scripted workload. Owner: report 06.
- **Leak-detection benchmark** — (client) heap-snapshot diff over K navigations;
  (server) RSS growth over M ws connections / messages; bounded-growth pass/fail.
  Owner: report 07.

Each becomes a new KPI script here (same `lib.mjs` + `recordResult` +
`budgets.json` conventions) so its before/after is reproducible by anyone.

---

## 5. Definition of done (the goal's exit condition)

The effort is done when ALL hold:

1. Every landed optimization has a recorded real before/after delta (section 2).
2. `budgets.json` has been ratcheted to lock in the wins.
3. The full correctness gate (section 3) is green: pages load, agent chats,
   views switch, view-dependent actions fire, no e2e regressions.
4. `bun run --cwd packages/app typecheck` + `bun run verify` pass for touched
   packages.
5. We can no longer find a high-confidence win that doesn't degrade UX, and no
   UX upgrade remains that doesn't hurt a measured KPI — the two are balanced and
   documented.
