# @elizaos/benchmark-framework

Measures runtime overhead with a real AgentRuntime, controlled model responses, and optional live-model runs.

Install workspace dependencies with `bun install` at the repository root.

No separate build script; this workspace runs from source.

Run timing regression tests with `bun run test` from this directory.

Validate types:

```bash
bun run --cwd packages/benchmarks/framework/typescript typecheck
```
