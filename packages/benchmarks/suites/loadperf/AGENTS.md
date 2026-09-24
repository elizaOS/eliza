# Load / Perf KPI Harness — Agent Guide

Four standalone Node ESM KPI scripts that measure app load performance (bundle
size, cold-boot time, web vitals, and WebSocket state-sync skew), compare each
against `budgets.json`, and exit non-zero on budget failure. Not registered in
the suite orchestrator — run directly with `node`.

## Target checkout (`ELIZA_REPO`)

These KPIs measure the elizaOS app itself, which lives in a separate checkout
of [elizaOS/eliza](https://github.com/elizaOS/eliza) — not in this repo. Set
`ELIZA_REPO` to the root of that checkout before running any KPI that touches
the app build or spawns the agent (`bundle`, `boot`, and `frontend` without
`--url`). `statesync` and `frontend --url` only need a live server URL.

```bash
export ELIZA_REPO=~/eliza          # your elizaOS/eliza checkout
bun run --cwd "$ELIZA_REPO/packages/app" build
```

## Run

```bash
# Bundle size (requires $ELIZA_REPO/packages/app/dist — build first)
node suites/loadperf/bundle-kpi.mjs

# Cold boot (spawns dev-server, polls /api/health)
node suites/loadperf/boot-kpi.mjs
# Against an already-running server:
LOADPERF_BASE_URL=http://127.0.0.1:31337 node suites/loadperf/boot-kpi.mjs --attach

# Frontend web-vitals (needs playwright + chromium)
node suites/loadperf/frontend-kpi.mjs
# Against a running dev server:
node suites/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138

# State-sync skew (needs a live WebSocket server)
LOADPERF_BASE_URL=http://127.0.0.1:31337 node suites/loadperf/statesync-kpi.mjs

# All KPIs + consolidated dashboard (results/summary/latest.md + latest.json)
node suites/loadperf/run-all.mjs
node suites/loadperf/run-all.mjs --no-boot --no-frontend   # bundle only (CI-light)
LOADPERF_BASE_URL=http://127.0.0.1:31337 node suites/loadperf/run-all.mjs --statesync
```

## Smoke test (no API keys)

```bash
# Bundle KPI needs only $ELIZA_REPO/packages/app/dist — no server, no browser, no keys.
node suites/loadperf/bundle-kpi.mjs
```

Frontend and statesync KPIs degrade to exit-code `2` (skipped) rather than
failing when playwright/chromium or a live server is absent.

## Test the harness

`frontend-kpi.test.mjs` covers the static-dist server and budget checks:

```bash
npx vitest run frontend-kpi.test.mjs
```

For the rest, verify by running the bundle KPI against a built dist as shown above.

## Layout

| Path | Role |
| --- | --- |
| `run-all.mjs` | Orchestrates all KPIs; writes `results/summary/` dashboard |
| `bundle-kpi.mjs` | Brotli bundle-size checks (no server needed) |
| `boot-kpi.mjs` | Cold-start readyMs + peak RSS |
| `frontend-kpi.mjs` | FCP / LCP / CLS / JS-transfer via headless Chromium |
| `statesync-kpi.mjs` | WebSocket broadcast skew p50/p95 + reconnect time |
| `lib.mjs` | Shared utilities (size helpers, result recording, git context) |
| `budgets.json` | Hard budget thresholds for all KPIs |
| `BASELINE.md` | Measured baseline values and top optimization targets |
| `results/` | Timestamped JSON results (gitignored; only `.gitignore` committed) |

## Notes

- Results write to `results/<kpi>/latest.json` and `results/summary/latest.md`
  (the `results/` tree is gitignored).
- Exit codes: `0` pass, `1` budget failure, `2` skipped/unavailable — usable
  directly as CI gates.
- Not registered in the suite registry — no orchestrator invocation.
- `BASELINE.md` documents the current measured numbers; ratchet `budgets.json`
  down as optimizations land (monotonic improvement is the goal).
- Full environment variable reference: [README.md](README.md).
