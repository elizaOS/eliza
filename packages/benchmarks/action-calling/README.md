# action-calling

Native function-calling benchmark. Samples planner records from
`training/data/native/records/hermes-fc-v1.jsonl` where the expected planner
output includes one or more tool calls, then for each:

1. Sends the prompt with OpenAI-compatible `tools`.
2. Reads the provider's native `tool_calls` field.
3. Asserts the emitted tool names match, arguments are JSON objects, required
   keys are present, and the complete argument objects match recursively with
   JSON types preserved.

Reported metrics:

- `native_tool_calls_ok` — provider emitted real tool calls.
- `tool_name_match` — emitted tool names match expected.
- `args_parse_ok` — action args parse cleanly.
- `required_keys_ok` — required arg keys present.
- `arguments_match` — complete argument objects match recursively, including
  exact object keys, list shapes, and JSON scalar types. The only tolerated
  representation differences are equivalent ISO datetimes and equal
  non-boolean JSON numbers such as `1` and `1.0`.

Score = geometric mean of the five metrics (in [0, 1], higher better).

Live runs require the official corpus and never silently substitute the
one-row smoke fixture. The result records the resolved corpus path, SHA-256,
raw row count, loaded eligible cases, evaluated cases, and pinned contract
manifests. Its full 693-row case ledger includes every prompt, tool schema,
expected call, predicted call, generation source, and five case outcomes. The
publication registry independently recomputes every outcome, aggregate, and
manifest from that ledger instead of trusting reported ratios or booleans.

## Run

```
python -m benchmarks.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```
