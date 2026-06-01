# Load / Perf KPI Harness — Agent Guide

Four standalone Node ESM KPI scripts that measure app load performance (bundle
size, cold-boot time, web vitals, and WebSocket state-sync skew), compare each
against `budgets.json`, and exit non-zero on budget failure. Not registered in
the suite orchestrator — run directly with `node`.

## Run

```bash
# Bundle size (requires packages/app/dist — build first)
bun run --cwd packages/app build
node packages/benchmarks/loadperf/bundle-kpi.mjs

# Cold boot (spawns dev-server, polls /api/health)
node packages/benchmarks/loadperf/boot-kpi.mjs
# Against an already-running server:
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/boot-kpi.mjs --attach

# Frontend web-vitals (needs playwright + chromium)
node packages/benchmarks/loadperf/frontend-kpi.mjs
# Against a running dev server:
node packages/benchmarks/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138

# State-sync skew (needs a live WebSocket server)
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/statesync-kpi.mjs

# All KPIs + consolidated dashboard (results/summary/latest.md + latest.json)
node packages/benchmarks/loadperf/run-all.mjs
node packages/benchmarks/loadperf/run-all.mjs --no-boot --no-frontend   # bundle only (CI-light)
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/run-all.mjs --statesync
```

## Smoke test (no API keys)

```bash
# Bundle KPI needs only packages/app/dist — no server, no browser, no keys.
bun run --cwd packages/app build
node packages/benchmarks/loadperf/bundle-kpi.mjs
```

Frontend and statesync KPIs degrade to exit-code `2` (skipped) rather than
failing when playwright/chromium or a live server is absent.

## Test the harness

There are no automated tests for this harness. Verify by running the bundle KPI
against a built dist as shown above.

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
