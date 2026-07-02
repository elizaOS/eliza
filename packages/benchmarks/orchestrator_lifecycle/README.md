# Orchestrator Lifecycle Benchmark

Evaluates the elizaOS agent's multi-turn orchestration behavior across
scripted lifecycle scenarios: clarifying underspecified requests, reporting
subagent status, acknowledging mid-flight scope changes, pause/resume/cancel
interruptions, and delivering stakeholder summaries. Each scenario is a
conversation defined in `scenarios/` with per-turn expected and forbidden
behavior tags. The evaluator scores keyword presence against those tags to
produce a pass rate and overall score.

## Quick Start

```bash
# Real evaluation (bridge mode — routes turns through the elizaOS TS bench server)
python -m benchmarks.orchestrator_lifecycle.cli \
  --provider openai --model gpt-4o \
  --output ./benchmark_results/orchestrator-lifecycle

# Smoke test (no keys, no server — deterministic simulator)
python -m benchmarks.orchestrator_lifecycle.cli \
  --mode simulate --max-scenarios 3 --output /tmp/olc-smoke

# Via the suite orchestrator
python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle --provider <p> --model <m>
```

See [AGENTS.md](AGENTS.md) for full layout, test commands, and scoring details.
