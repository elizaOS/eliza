# Framework Benchmark — Agent Guide

Measures the overhead of the elizaOS framework itself: a TypeScript (Bun) harness drives a real `AgentRuntime` with a deterministic mock-LLM plugin and in-memory DB, reporting latency, throughput, pipeline breakdown, memory, and startup across 20 scenarios.

Build, test, and setup: [README.md](README.md).
