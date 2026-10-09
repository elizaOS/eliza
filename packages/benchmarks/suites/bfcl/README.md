# BFCL — Berkeley Function-Calling Leaderboard

Berkeley Function-Calling Leaderboard benchmark: evaluates LLM function-calling accuracy across single-turn (AST equality), multi-turn (executable runtime state comparison), and agentic (web search, memory) categories.

This directory is part of `packages/benchmarks`.

Install the suite’s Python dependencies before running its tests.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/suites/bfcl/tests --import-mode=importlib
```
