# elizaOS Benchmark Orchestrator

Campaign runner for benchmark suites across agent harnesses, with resumable execution and result storage.

This directory is part of `packages/benchmarks`.

Build from the repository root:

```bash
bun run --cwd packages/benchmarks build:plugin
```

Test from the repository root:

```bash
bun run --cwd packages/benchmarks test:py
```

Native decision reports must record the selected fixture IDs and repetition count. Publication requires exactly those case IDs, including failed attempts; missing, duplicate or unexpected results remain diagnostic. Older reports without a selection manifest require explicit evidence-backed regrading before comparison.
