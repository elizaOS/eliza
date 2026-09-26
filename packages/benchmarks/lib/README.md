# @elizaos-benchmarks/lib

Shared infrastructure imported by every harness and the orchestrator in the LifeOpsBench
suite — not a runnable benchmark and not registered in the suite registry.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/lib typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
