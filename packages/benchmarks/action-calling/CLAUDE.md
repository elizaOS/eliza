# Action Calling — Agent Guide

Native function/tool-calling benchmark. Samples planner-style records from
`training/data/native/records/hermes-fc-v1.jsonl`, sends OpenAI-compatible
`tools` to the model, and scores the returned `tool_calls` on five axes.
Registered in the suite registry as `action-calling`.

## Run

```bash
# Direct, from the repo root (packages/benchmarks/)
python -m benchmarks.action-calling.cli \
    --provider vllm \
    --model eliza-1-9b \
    --out /tmp/action-calling-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```

## Smoke test (no API keys)

The `mock` provider echoes expected tool calls back, scoring 1.0 on all axes.
Falls back to `fixtures/smoke.jsonl` automatically when the full dataset is absent.

```bash
python -m benchmarks.action-calling.cli \
    --provider mock \
    --model smoke \
    --out /tmp/action-calling-smoke
```

## Test the harness

```bash
pytest packages/benchmarks/action-calling/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint and scoring logic |
| `fixtures/smoke.jsonl` | Minimal fixture record for mock/offline runs |
| `tests/test_action_calling_cli.py` | pytest suite for scoring helpers |

## Notes

- Results write to `<out>/action-calling-results.json` (path controlled by `--out`).
- Scored by `_score_from_action_calling_json` in `registry/scores.py`.
- Score = geometric mean of five sub-rates: `native_tool_calls_ok`, `tool_name_match`, `args_parse_ok`, `required_keys_ok`, `arguments_match`.
- Supports providers: `vllm`, `openai`, `groq`, `openrouter`, `anthropic`, `cerebras`, `eliza`, `hermes`, `openclaw`, `mock`.
- Harness selection (eliza/hermes/openclaw/smithers) can also be forced via `ELIZA_BENCH_HARNESS` or `BENCHMARK_HARNESS` env vars.
- Full background: [README.md](README.md).
