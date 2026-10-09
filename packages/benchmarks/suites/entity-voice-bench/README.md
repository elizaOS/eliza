# @elizaos/entity-voice-bench

Benchmark for **entity extraction from voice conversation** (#10726 pillar 4): does the
shipped pipeline recognize known speakers, create the right person entities, attach
facts to the right people, and keep confusable names (Maria/Mario/Marie, Erin/Aaron)
distinct?

## Development

Install dependencies with `bun install` at the repository root. Run from that root:


No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/entity-voice-bench bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

No standalone `test` script is defined in this package.
