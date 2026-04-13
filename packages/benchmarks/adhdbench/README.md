# ADHDBench

Attention & context scaling benchmark for ElizaOS agents. Measures whether an agent selects the correct action and context as cognitive load increases.

**Signature output:** an attention scaling curve — accuracy plotted against context load.

## Quick Start

```bash
cd benchmarks/adhdbench
pip install -e .

# List scenarios
python scripts/run_benchmark.py list

# Compute baselines (no LLM needed)
python scripts/run_benchmark.py baselines

# Quick run (L0 only, 2 scale points, ~5 min)
python scripts/run_benchmark.py run --quick --model gpt-4o-mini

# Full run (all levels, all scales, both configs)
python scripts/run_benchmark.py run --full --model gpt-4o
```

## Structure

**45 scenarios** across 3 levels:

| Level | Count | Tests |
|-------|-------|-------|
| L0: Action Dispatch | 20 | Single-turn: does the agent pick the right action? |
| L1: Context Tracking | 15 | Multi-turn: buried instructions, entity tracking, distraction resistance |
| L2: Complex Execution | 10 | Multi-step tasks: add contact -> send message -> schedule follow-up |

**5 scale points** from 10 to 200 registered actions.

**50 distractor actions** across 9 domains (DeFi, social, productivity, files, communication, analytics, moderation, content, gaming) that create semantic disambiguation pressure against bootstrap actions.

**2 configurations:** basic (no advanced features) vs full (advancedMemory + advancedPlanning).

**2 baselines:** random (~30%) and always-REPLY (~49%) for score calibration.

## Evaluation

Deterministic, binary. 7 outcome types:

- `ACTION_MATCH` / `ACTION_NOT_MATCH` — correct action selected (or forbidden action avoided)
- `TEXT_CONTAINS` / `TEXT_NOT_CONTAINS` — response content checks
- `PARAM_MATCH` — action parameters present in response
- `MEMORY_RECALLED` — fact from earlier conversation appears in response
- `PROVIDERS_REQUESTED` — specific context providers were invoked

## Output

- Scaling curve (console + markdown)
- Per-scenario scores with turn-level detail
- JSON traces for debugging
- Markdown report with failure analysis

## Files

```
elizaos_adhdbench/
    types.py              196 lines — frozen scenario/result types
    config.py              89 lines — all tuneable axes
    scenarios.py          598 lines — 45 scenarios with outcome definitions
    distractor_plugin.py  758 lines — 50 actions + variant generator
    evaluator.py          237 lines — 7 deterministic evaluators + scoring
    baselines.py           98 lines — random + always-REPLY baselines
    runner.py             ~450 lines — orchestration with error handling + logging
    runtime_wrapper.py    242 lines — trajectory logger service
    reporting.py          240 lines — markdown, JSON, ASCII curves
tests/                    142 passing tests
scripts/run_benchmark.py  CLI with run, baselines, list commands
```

## Running Tests

```bash
pip install -e ".[dev]"
pytest tests/ -v
```
