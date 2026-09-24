# action-calling

Native function-calling benchmark. Samples planner records from
the elizaOS training corpus `hermes-fc-v1.jsonl` (place it at `<repo>/training/data/native/records/hermes-fc-v1.jsonl` or set `ELIZA_TRAINING_ROOT` / pass `--test-file`) where the expected planner
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
python -m benchmarks.suites.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```

## Install the pinned corpus

From the checkout's parent directory (the checkout must be named `benchmarks`):

```bash
python -m benchmarks.action-calling.install_corpus \
  --destination benchmarks/training/data/native/records
```

This downloads the immutable `action-calling-corpus-v1` data release and verifies
both compressed and complete decoded SHA-256 hashes, byte counts and all 11,578
JSONL records before publishing `hermes-fc-v1.jsonl`. Apache-2.0 license text,
upstream attribution and exact source/converter provenance accompany the file.
The source dataset declares Apache-2.0 at its pinned revision; converted planner
records retain the benchmark's existing checksum and workload, without filtering
or rewriting their contents.

Use `--archive /path/to/hermes-fc-v1.jsonl.gz` for an offline installation with
the same checks. A repeat command revalidates the complete installation.
Unrelated or incomplete existing directories are never overwritten; choose a
fresh destination after a failed attempt. Partial download files are retained
for diagnosis and never published as the benchmark corpus. For a custom
installation directory, pass its `hermes-fc-v1.jsonl` with the runner's
`--test-file` option. Installing data is not a model evaluation or score.
