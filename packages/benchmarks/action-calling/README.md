# action-calling

Native function-calling benchmark. Samples planner records from
`training/data/native/records/hermes-fc-v1.jsonl` where the expected planner
output includes one or more tool calls, then for each:

1. Sends the prompt with OpenAI-compatible `tools`.
2. Reads the provider's native `tool_calls` field.
3. Asserts the emitted tool names match, arguments are JSON objects, required
   keys are present, and expected argument values are preserved.

Reported metrics:

- `native_tool_calls_ok` — provider emitted real tool calls.
- `tool_name_match` — emitted tool names match expected.
- `args_parse_ok` — action args parse cleanly.
- `required_keys_ok` — required arg keys present.
- `arguments_match` — expected argument values are present.

Score = geometric mean of the four (in [0, 1], higher better).

## Run

```
python -m benchmarks.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```
