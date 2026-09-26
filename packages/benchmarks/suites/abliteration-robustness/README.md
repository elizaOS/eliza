# Abliteration robustness

Measures model over-refusal on harmless prompts. This is a raw model benchmark,
not an agent-loop evaluation. No build step is needed.

With Python 3.11+ and benchmark dependencies installed, run from the repository root:

```bash
# Benchmark (requires provider credentials)
PYTHONPATH=packages python3 -m benchmarks.orchestrator run --benchmarks abliteration-robustness --provider <provider> --model <model>
# Test
PYTHONPATH=packages python3 -m pytest packages/benchmarks/suites/abliteration-robustness/tests
```
