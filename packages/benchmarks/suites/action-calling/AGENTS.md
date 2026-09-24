# Action Calling — Agent Guide

Native function/tool-calling benchmark. Samples planner-style records from
the elizaOS training corpus `hermes-fc-v1.jsonl` (place it at `<repo>/training/data/native/records/hermes-fc-v1.jsonl` or set `ELIZA_TRAINING_ROOT` / pass `--test-file`), sends OpenAI-compatible
`tools` to the model, and scores the returned `tool_calls` on five axes.
Registered in the suite registry as `action-calling`.

## Run

```bash
# Direct, from the repo root (suites/)
python -m benchmarks.action-calling.cli \
    --provider vllm \
    --model eliza-1-9b \
    --expand-scenarios \
    --expected-examples 63 \
    --out /tmp/action-calling-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.suites.orchestrator run \
    --benchmarks action-calling \
    --provider vllm \
    --model eliza-1-9b
```

## Smoke test (no API keys)

The `mock` provider echoes expected tool calls back, scoring 1.0 on all axes.
Only mock runs may fall back to `fixtures/smoke.jsonl` when the full dataset is
absent. Live harnesses fail closed unless the official corpus exists or the
operator passes an explicit `--test-file`.
The pinned full campaign validates all 63 eligible cases from the 11,578-row
corpus and all 630 derived edge cases; it has no silent maximum-example cap.

```bash
python -m benchmarks.action-calling.cli \
    --provider mock \
    --model smoke \
    --out /tmp/action-calling-smoke
```

## Test the harness

```bash
pytest suites/action-calling/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint, corpus recovery, and report generation |
| `../action_calling_contract.py` | Shared recursive case scorer used by the runner and publication registry |
| `fixtures/smoke.jsonl` | Minimal fixture record for mock/offline runs |
| `tests/test_action_calling_cli.py` | pytest suite for scoring helpers |

## Notes

- Results write to `<out>/action-calling-results.json` (path controlled by `--out`).
- Results record the resolved dataset path, SHA-256, raw row count, loaded base
  case count, evaluated case count, and pinned base/evaluated/ID manifests.
- `--expected-examples` validates the base-case count before expansion, so the
  pinned full run uses `--expected-examples 63 --expand-scenarios` to evaluate
  693 cases.
- Every full result contains a 693-row case ledger with the model-visible
  messages and tools, expected and predicted calls, generation source, and all
  five per-case outcomes. `_score_from_action_calling_json` in
  `registry/scores.py` independently validates the manifests and recomputes
  every outcome, aggregate, and final score from that ledger.
- `arguments_match` requires exact recursive object keys, array shapes, and
  JSON scalar types. Only equivalent ISO datetimes and equal non-boolean JSON
  numbers such as `1` and `1.0` are representation-equivalent.
- Score = geometric mean of five sub-rates: `native_tool_calls_ok`, `tool_name_match`, `args_parse_ok`, `required_keys_ok`, `arguments_match`.
- Supports providers: `vllm`, `openai`, `groq`, `openrouter`, `anthropic`, `cerebras`, `eliza`, `hermes`, `openclaw`, `mock`.
- Harness selection (eliza/hermes/openclaw/smithers) can also be forced via `ELIZA_BENCH_HARNESS` or `BENCHMARK_HARNESS` env vars.
- Full background: [README.md](README.md).


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
