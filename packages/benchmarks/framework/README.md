# Framework benchmark

Measures runtime overhead with a real AgentRuntime and controlled model responses. Live-model runs are optional.

From the repository root:

```bash
bun run --cwd packages/benchmarks/framework/typescript typecheck
bun run --cwd packages/benchmarks/framework/typescript bench:quick
```

Reports default to `test-results/benchmark-framework/`. Set `BENCHMARK_OUTPUT_ROOT` or pass an explicit output path to use another directory. `compare.ts --dir=...` and `visualize.py <directory>` can read existing archives. The root Python test lane does not exercise this TypeScript workload.
