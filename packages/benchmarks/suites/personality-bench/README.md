# @elizaos/personality-bench

Layered judge for personality consistency evaluation.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/personality-bench test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/personality-bench grade`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

The complete authored corpus is in `scenarios/`, grouped into five manifests.
Run `bun run --cwd packages/benchmarks/suites/personality-bench scenarios:validate`
for static discovery, or pass that directory to the shared scenario runner for
execution. Scenario IDs, full prompts, turn history and rubrics are preserved.
