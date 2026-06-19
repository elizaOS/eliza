# Load / Perf KPI Harness

Zero-build performance KPI suite for the app. Each KPI is a standalone Node ESM
script that measures one dimension, compares against `budgets.json`, records a
timestamped JSON result under `results/<kpi>/`, and exits non-zero when a hard
budget is exceeded. Run any of them directly with `node` — no build or install
step (the optional `playwright` / WebSocket deps degrade to a clearly-marked
`skipped` result when unavailable).

All sizes are **brotli**-compressed bytes unless noted (matching what a CDN
serves). Budget keys live in `budgets.json`.

## KPIs

| KPI | Script | What it measures | Needs |
| --- | --- | --- | --- |
| bundle | `bundle-kpi.mjs` | on-disk bundle size: initial entry, total assets, largest chunk, duplicate-lib waste | `packages/app/dist` |
| boot | `boot-kpi.mjs` | cold-start `readyMs` + peak RSS of the headless agent | spawns dev-server (or `--attach`) |
| frontend | `frontend-kpi.mjs` | FCP / LCP / CLS, JS transferred, request count, long-task time | `playwright` + a browser |
| statesync | `statesync-kpi.mjs` | broadcast skew p50/p95, desync events, reconnect time | a running WS server |

## Running

```bash
# Bundle size (off the on-disk build; build first with `bun run --cwd packages/app build`)
node packages/benchmarks/loadperf/bundle-kpi.mjs

# Cold boot (spawns the headless agent, polls /api/health)
node packages/benchmarks/loadperf/boot-kpi.mjs
# …against an already-running server:
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/boot-kpi.mjs --attach

# Frontend web-vitals (serves dist on an ephemeral port, drives headless Chromium)
node packages/benchmarks/loadperf/frontend-kpi.mjs
node packages/benchmarks/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138

# State-sync (needs a live WS server)
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/statesync-kpi.mjs
LOADPERF_WS_URL=ws://127.0.0.1:31337/ws node packages/benchmarks/loadperf/statesync-kpi.mjs

# All of them + a consolidated dashboard
node packages/benchmarks/loadperf/run-all.mjs                       # bundle + boot + frontend
node packages/benchmarks/loadperf/run-all.mjs --no-boot --no-frontend  # bundle only (CI-light)
LOADPERF_BASE_URL=http://127.0.0.1:31337 node packages/benchmarks/loadperf/run-all.mjs --statesync
```

`run-all.mjs` writes `results/summary/latest.md` (+ `latest.json` and timestamped
copies). It exits non-zero only when a KPI that actually ran reports a budget
failure — `skipped` KPIs (missing browser / no server) do not fail the suite.

## Environment knobs

| Var | KPI | Default | Meaning |
| --- | --- | --- | --- |
| `ELIZA_API_PORT` | boot | `31337` | API port for the spawned/attached server |
| `LOADPERF_BASE_URL` | boot, statesync | derived | base URL to probe |
| `LOADPERF_BOOT_TIMEOUT_MS` | boot | `120000` | ready timeout |
| `LOADPERF_FE_URL` / `--url=` | frontend | serve dist | target URL instead of static dist |
| `LOADPERF_FE_SETTLE_MS` | frontend | `8000` | settle time before reading metrics |
| `LOADPERF_CLIENTS` | statesync | `4` | concurrent WS clients |
| `LOADPERF_WS_URL` | statesync | derived | explicit ws/wss URL |
| `LOADPERF_WS_PATH` | statesync | `/ws` | path appended to base URL |
| `LOADPERF_WS_TOKEN` | statesync | — | appended as `?token=…` |
| `LOADPERF_OBSERVE_MS` | statesync | `14000` | broadcast observation window |

## Exit codes

`0` pass, `1` budget failure, `2` skipped/unavailable. This makes each KPI usable
directly as a CI gate.

## Budgets as a CI gate

`budgets.json` is the contract. Wire `bundle-kpi.mjs` (and, where a server/browser
is available, the others) into CI: a budget regression exits non-zero and fails
the job. The intent is **monotonic improvement** — as optimizations land, ratchet
the budgets *down* so they can never silently regress. See `BASELINE.md` for the
current measured numbers and the top optimization targets.
