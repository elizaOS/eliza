# @elizaos/configbench

Plugin configuration & secrets security benchmark: 62 authored scripted scenarios
(expanded 10× with edge variants to 682 total) testing `@elizaos/core` built-in secrets
(CRUD, encryption, leakage prevention, DM enforcement, social-engineering resistance)
and the built-in plugin manager (lifecycle, activation, onboarding).

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/configbench test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/configbench bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.
