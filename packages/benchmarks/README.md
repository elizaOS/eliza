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

The [benchmark workflow](../../.github/workflows/benchmarks.yml) validates the
shared Python infrastructure, orchestrator, inventory, and runtime smoke checks.
Install `requirements-ci.txt` for that lane. Live framework runs are explicit
manual selections requiring credentials; harness unit suites use
`pytest --import-mode=importlib`. Docker execution requires
`BENCHMARK_DOCKER_TESTS=1` and the pinned evaluator image.

Eliza's OSWorld and VisualWebBench HTTP routes require native image-description
capability. Select an auxiliary model/endpoint with
`--extra '{"vision_model":"<model>","vision_base_url":"<url>"}'`; configure its key
through `OPENAI_IMAGE_DESCRIPTION_API_KEY`. Otherwise the orchestrator uses the
configured image model or the selected primary model. Results record image-model
usage, and comparison groups include the configured vision model and endpoint
fingerprint. A successful transport test is not a live vision-quality score.
