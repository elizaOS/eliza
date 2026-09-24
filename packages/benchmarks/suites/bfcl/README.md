# BFCL — Berkeley Function-Calling Leaderboard

Berkeley Function-Calling Leaderboard benchmark: evaluates LLM function-calling accuracy across single-turn (AST equality), multi-turn (executable runtime state comparison), and agentic (web search, memory) categories.

This directory is part of `packages/benchmarks`.

Build from the repository root:

```bash
bun run --cwd packages/benchmarks build:plugin
```

Test from the repository root:

```bash
bun run --cwd packages/benchmarks test:py
```
