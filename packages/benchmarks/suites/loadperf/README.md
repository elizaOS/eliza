# Load / Perf KPI Harness

Four standalone Node ESM KPI scripts that measure app load performance (bundle size, cold-boot time, web vitals, and WebSocket state-sync skew), compare each against `budgets.json`, and exit non-zero on budget failure.

This directory is part of `packages/benchmarks`.

Build from the repository root:

```bash
bun run --cwd packages/benchmarks build:plugin
```

Test from the repository root:

```bash
bun run --cwd packages/benchmarks test:py
```
