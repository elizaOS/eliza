# @elizaos/lifeops-quality-bench

Personal-assistant quality benchmarks for inbox triage and reminder timeliness.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/lifeops-quality test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/lifeops-quality bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

The default test is the keyless scheduler gate over PGlite and real plugin code.
Set `ELIZA_REPO_DIR` to test another checkout with its dependencies installed
and personal-assistant dependency graph built.
