# @elizaos/voicebench

End-to-end voice latency benchmark for the elizaOS TypeScript runtime.

The [quality sub-suite](quality/README.md) implements the published VoiceBench
spoken-instruction evaluation. Its `voicebench_quality` ID and quality score
remain separate from this package's latency measurements.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/voicebench bench  # benchmark validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package.

Run the harness with `bun run --cwd packages/benchmarks/suites/voicebench bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.
