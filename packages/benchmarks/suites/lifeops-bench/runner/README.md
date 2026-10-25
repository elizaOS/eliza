# LifeOps simulated backend

The public package owns LifeOps world mutation and task-route contracts.
The shared HTTP host lives in `../../../harnesses/eliza/runner`.

From the repository root, run:

```bash
bun run --cwd packages/benchmarks/suites/lifeops-bench/runner typecheck
bun run --cwd packages/benchmarks/harnesses/eliza/runner test
```

The existing `benchmark:server` command delegates to the shared host.
