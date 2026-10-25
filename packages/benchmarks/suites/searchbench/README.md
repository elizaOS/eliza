# @elizaos/searchbench

Regression benchmark for corpus-wide chat message search (Postgres FTS + `pg_trgm`)
against a **real** ≥10k-message PGlite store.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/searchbench bench  # benchmark validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package.

Run the harness with `bun run --cwd packages/benchmarks/suites/searchbench bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.
