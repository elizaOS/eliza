# elizaOS Benchmarks

Benchmark suites, agent harness adapters, scoring, and result inspection.
Requires Python 3.11+; individual suites may require newer Python, extra
libraries, model credentials, Docker, or hardware.

From the repository root, run `bun install`. Create a Python virtual environment
and install pytest plus the selected suite's `requirements.txt` or `pyproject.toml`
dependencies. Keep `packages/` on `PYTHONPATH` when running Python modules.

```bash
# Build the benchmark action plugin
bun run --cwd packages/benchmarks build:plugin
# Test the shared Python benchmark infrastructure
PYTHONPATH="$PWD/packages" bun run --cwd packages/benchmarks test:py
# List available benchmarks
PYTHONPATH=packages python3 -m benchmarks.orchestrator list-benchmarks
# Run one benchmark with the selected provider/model
PYTHONPATH=packages python3 -m benchmarks.orchestrator run --benchmarks <id> --provider <provider> --model <model>
```

Each suite's README documents its own tests and setup. Live runs require provider
credentials and may incur costs. Generated results belong in ignored output
directories; a mock run proves harness behavior, not model quality.
