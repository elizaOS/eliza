# action-calling

Strict-format action emission benchmark. Samples records from
`training/data/final/test.jsonl` where the expected response includes a
non-trivial action call (planner-style: ``message_handler`` /
``agent_trace`` / ``tool_call`` / ``mcp_tool_call``), then for each:

1. Sends the prompt + tool specs (`availableActions`) through the model.
2. Parses the output as TOON.
3. Asserts the emitted action name matches the ground-truth name, action
   args parse as JSON, and required arg keys are present.

Reported metrics:

- `format_ok` — TOON parse success rate.
- `action_name_match` — emitted action name matches expected.
- `args_parse_ok` — action args parse cleanly.
- `required_keys_ok` — required arg keys present.

Score = geometric mean of the four (in [0, 1], higher better).

## Run

```
python -m benchmarks.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```
