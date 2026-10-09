# @elizaos/interrupt-bench

TypeScript benchmark for **interruption handling** in the elizaOS agent runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/interrupt-bench typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/interrupt-bench bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
