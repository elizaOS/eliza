# ADHDBench — Agent Guide

Attention & context scaling benchmark for ElizaOS agents. Measures whether an
agent selects the correct action and context as cognitive load increases, producing
an attention scaling curve (accuracy vs. context load). Not registered in the
suite orchestrator registry — run directly via its own CLI.

## Run

```bash
# From this directory
cd packages/benchmarks/adhdbench
pip install -e .

# Quick run (L0 only, 2 scale points, ~5 min)
python scripts/run_benchmark.py run --quick --model openai/gpt-oss-120b --provider openai

# Full run (all levels, all scales, both configs)
python scripts/run_benchmark.py run --full --model gpt-4o --provider openai

# Route through the ElizaOS TypeScript benchmark bridge
python scripts/run_benchmark.py run --full --model gpt-4o --provider eliza

# List all scenarios
python scripts/run_benchmark.py list

# Compute baselines (no LLM needed)
python scripts/run_benchmark.py baselines
```

`--provider` is required (no default). Choices: `mock-passthrough`, `eliza`,
`openai`, `cerebras`, `groq`, `openrouter`, `vllm`.

## Smoke test (no API keys)

```bash
python scripts/run_benchmark.py run --quick --provider mock-passthrough
```

`mock-passthrough` is the deterministic local runner — always scores ~100% by
construction; useful only for harness smoke tests.

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `scripts/run_benchmark.py` | CLI entrypoint (`run`, `baselines`, `list` subcommands) |
| `elizaos_adhdbench/runner.py` | Orchestration loop (mock-passthrough path) |
| `elizaos_adhdbench/openai_runner.py` | OpenAI-compatible provider runner |
| `elizaos_adhdbench/scenarios.py` | 45 scenarios across L0/L1/L2 |
| `elizaos_adhdbench/distractor_plugin.py` | 50 distractor actions across 9 domains |
| `elizaos_adhdbench/evaluator.py` | 7 deterministic binary evaluators |
| `elizaos_adhdbench/config.py` | All tuneable axes (scale points, levels, configs) |
| `elizaos_adhdbench/types.py` | Frozen scenario/result types |
| `elizaos_adhdbench/reporting.py` | Markdown, JSON, ASCII scaling curve output |
| `tests/` | pytest suite (142 passing tests) |

## Notes

- Results write to `./adhdbench_results/` by default (override with `--output`).
- Not registered in `registry/commands.py` or `registry/scores.py` — no orchestrator invocation path.
- 45 scenarios across 3 levels: L0 (action dispatch), L1 (context tracking), L2 (complex execution).
- 5 scale points: 10–200 registered actions; 2 configurations: basic vs full (advancedMemory + advancedPlanning).
- Full background: [README.md](README.md).
