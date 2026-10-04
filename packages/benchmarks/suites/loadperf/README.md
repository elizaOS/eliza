# Load / Perf KPI Harness

Four standalone Node ESM KPI scripts that measure app load performance (bundle size, cold-boot time, web vitals, and WebSocket state-sync skew), compare each against `budgets.json`, and exit non-zero on budget failure.

This directory is part of `packages/benchmarks`.

This harness runs from source.

Test from the repository root:

```bash
bunx vitest run packages/benchmarks/suites/loadperf/frontend-kpi.test.mjs
```
