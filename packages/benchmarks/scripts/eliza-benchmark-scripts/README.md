# @elizaos-benchmarks/eliza-benchmark-scripts

Bun entrypoints for generating runtime traces consumed by Python benchmarks.

Install workspace dependencies with `bun install` at the repository root.

No separate build script; this workspace runs from source.

No dedicated test script is defined.

The context-drift harness owns its historical lossy compaction baselines here.
They are experimental controls, not production context policy. For a local harness
check (not a model-quality measurement):

```bash
bun packages/benchmarks/scripts/eliza-benchmark-scripts/drift-harness.ts --strategy naive-summary --dry-run --turns 12
```

`agent/` owns the Cerebras latency/cache/evaluator/planner experiments, relevant
conversation benchmark and proactive-greeting provider probe. The agent package's
`perf:cerebras-chat` and `perf:relevant-conversations` commands remain aliases.
Live commands require the configured provider credentials and may incur charges;
dry-run/replay results do not establish live model quality.
