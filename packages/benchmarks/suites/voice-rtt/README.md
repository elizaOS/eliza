# @elizaos/voice-rtt-bench

Provider-agnostic TypeScript benchmark for end-to-end voice latency: Deepgram Flux ->
Cerebras `gemma-4-31b` -> Cartesia Sonic 3.5.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/voice-rtt typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/voice-rtt bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
