# @elizaos/plugin-benchmarks

Canonical elizaOS Action wrappers for benchmark tool vocabularies (vending-bench,
webshop, OSWorld, tau-bench, visualwebbench).

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/plugin-benchmarks build  # build
bun run --cwd packages/benchmarks/plugin-benchmarks typecheck  # static validation
```

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
