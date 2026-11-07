# Orchestrator Lifecycle Benchmark

Multi-turn orchestration lifecycle benchmark: evaluates the elizaOS agent's ability to handle clarification requests, status check-ins, scope changes, pause/resume/cancel interruptions, and stakeholder summaries across scripted scenario conversations.

This directory is part of `packages/benchmarks`.

Install the suite’s Python dependencies before running its tests.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/suites/orchestrator_lifecycle/tests --import-mode=importlib
```
