# Standard academic benchmarks

MMLU, HumanEval, GSM8K, and MT-Bench adapters. These measure raw model quality;
they do not exercise the Eliza agent loop. No build step is needed.

With Python 3.11+ and the benchmark dependencies installed, run from the repository root:

```bash
# Run a benchmark (requires provider credentials)
PYTHONPATH=packages python3 -m benchmarks.standard.mmlu --provider openai --model <model> --output /tmp/mmlu-out
# Test the adapters
PYTHONPATH=packages python3 -m pytest packages/benchmarks/suites/standard/tests
```
