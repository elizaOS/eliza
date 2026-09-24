# @elizaos/bench-vision-language

Vision-language + UI-grounding eval harness for the eliza-1 model line.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/vision-language test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/vision-language start`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.
