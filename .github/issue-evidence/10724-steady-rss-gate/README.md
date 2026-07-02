# #10724 — steady-state RSS regression gate for the booted keyless agent

Scope B (backend/agent) guardrail. `loadperf/boot-kpi.mjs` already gates cold
`readyMs` and boot **peak** RSS, but had no gate on the **steady-state idle RSS**
a booted agent carries once boot churn subsides — a distinct regression class
(boot scratch never released, slow idle growth) that the peak number hides.

## What shipped

`boot-kpi.mjs` now, after `ready`, holds the idle keyless/headless agent for a
settle window (`LOADPERF_STEADY_SETTLE_MS`, default 12 s), samples `/proc/<pid>`
VmRSS, and reports **`steadyRssMb`** = median of the window's tail (last 60 %,
after GC/scratch churn). Gated against `budgets.json → boot.steadyRssMb` (1500 MB).
A `null` budget records without gating; `--attach` reports `null` (no child pid).

## Real measurement (this host)

Prod path (`bun run dist/entry.js start`, keyless/headless), `--runs=2`, 12 s
settle, heavily CPU-contended host (loadavg 51 / 24 cpus — RSS is
contention-insensitive):

```
peak RSS:    1057.6 MB   (budget 1600 MB — PASS)
steady RSS:  1069.0 MB   (budget 1500 MB — PASS)   <-- new gate
ready median: 14655 ms   (budget 25000 ms — PASS)
health.ready: true
```

Steady sits slightly **above** boot-peak because RSS keeps climbing during
post-ready warmup (lazy provider/embedding load, GC not yet run) — the exact
resident tail the boot-peak sample misses, which is why the separate metric
earns its keep. Full recorded result: `boot-kpi-result.json`.

## Budget rationale

`steadyRssMb ≤ 1500 MB` = ~40 % headroom over the measured 1069 MB and above the
historical ~1272 MB peak reading, so it catches a real resident regression
(~430 MB idle leak) without flaking on host variance. Ratchet down as
idle-footprint optimizations land.

## Repro

```bash
bun run --cwd packages/app-core build       # build the shipped entry the KPI measures
node packages/benchmarks/loadperf/boot-kpi.mjs --runs=2
# or the whole harness:
node packages/benchmarks/loadperf/run-all.mjs --no-frontend
```

Screenshots/video: N/A — a CI/benchmark gate, no UI/runtime visual surface.
