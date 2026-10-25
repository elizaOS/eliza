# @solana-gauntlet/sdk

TypeScript SDK for Solana Gauntlet AI Agent Benchmark

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/gauntlet/sdk/typescript build  # build
bun run --cwd packages/benchmarks/suites/gauntlet/sdk/typescript typecheck  # static validation
```

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
