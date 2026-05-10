# LifeOpsBench

Multi-turn, tool-use benchmark for life-assistant agents. Three swappable
backend adapters (elizaOS, OpenClaw, NousResearch Hermes-template models)
evaluated on the same scenarios with state-hash + LLM-judge scoring.

See `PLAN.md` for architecture, build waves, and scoring methodology.

## Install

```bash
cd packages/benchmarks/lifeops-bench
uv sync
# or
pip install -e .[anthropic,test]
```

## Quick start

List the registered scenarios:

```bash
python -m eliza_lifeops_bench --list-scenarios
```

Run the calendar smoke scenario against the perfect reference agent:

```bash
python -m eliza_lifeops_bench --agent perfect --domain calendar
```

Run a single scenario by id with multiple seeds:

```bash
python -m eliza_lifeops_bench \
    --scenario smoke_static_calendar_01 \
    --agent perfect \
    --seeds 5
```

Default models: evaluator/user-simulator is `gpt-oss-120b` (Cerebras),
judge is `claude-opus-4-7`. Override with `--evaluator-model` and
`--judge-model`.

## Tests

```bash
python -m pytest tests/ -v
```
