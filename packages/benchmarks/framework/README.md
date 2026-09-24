# Eliza Framework Benchmark

Measures the overhead of the elizaOS framework itself: a TypeScript (Bun) harness drives a real `AgentRuntime` with a deterministic mock-LLM plugin and in-memory DB, reporting latency, throughput, pipeline breakdown, memory, and startup across 21 scenarios.

This directory is part of `packages/benchmarks`.

Build from the repository root:

```bash
bun run --cwd packages/benchmarks build:plugin
```

Test from the repository root:

```bash
bun run --cwd packages/benchmarks test:py
```
