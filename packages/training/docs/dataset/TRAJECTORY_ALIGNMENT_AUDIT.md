# Native trajectory alignment audit

This audit checks whether downloaded bootstrap corpora can be transformed into
the final `eliza_native_v1` model-boundary row: the exact request Eliza sends
through the Vercel AI SDK plus the normalized response returned by the model.
The comparison target is the real stage sequence Eliza currently records:

1. Stage 1 `message_handler`
2. planner native tool calls
3. tool result events
4. central evaluator decisions
5. append-only multi-call trajectory context with cache-visible prefixes

It also prints reference trajectories for four canonical runtime paths:

- `simple_reply`: Stage 1 direct reply, no planner
- `wallet_context`: context selection, queued wallet tools, evaluation after
  each tool
- `email_context`: email search plus draft creation
- `calendar_context`: calendar find, availability check, event creation

## Run

```bash
uv run --with pyyaml --with pyarrow \
  python scripts/sample_native_trajectory_alignment.py \
  --samples-per-source 10 --run-cerebras
```

If `CEREBRAS_API_KEY` is set, the reference model stages call Cerebras
`gpt-oss-120b`. If the key is absent, the script still writes deterministic
offline fixtures and marks `modelRun.mode = offline_fixture`.

## Outputs

All outputs live under ignored local data:

- `data/native/audit/dataset_samples.jsonl`
  - randomized deterministic rows per downloaded dataset
  - each row includes a compact raw preview, inferred source features, and
    similarity scores against target runtime stages
- `data/native/audit/dataset_similarity.json`
  - per-dataset average stage similarity, transform family, quality rating,
    and missing critical signals
- `data/native/audit/runtime_reference_trajectories.json`
  - machine-readable reference trajectories
- `data/native/audit/runtime_reference_trajectories.md`
  - printed trajectories for human review
- `data/native/audit/model_call_shapes.json`
  - runtime `useModel` params, Cerebras chat-completions payload, and Vercel
    AI Gateway `generateText` common config for each reference model call
- `data/native/audit/real_eliza_trajectory_comparison.{json,md}`
  - sampled real local recorder files and the request/response components
    actually present on model stages
- `data/native/audit/real_eliza_native_rows.jsonl`
  - `eliza_native_v1` rows exported from real local Eliza recorder stages for
    immediate smoke training
- `data/native/audit/native_synthesis_templates.{json,md}`
  - per-dataset templates for missing components such as selected contexts,
    tool schemas, tool results, evaluator decisions, and runtime-only usage
- `data/native/audit/composition_audit.md`
  - summary table plus composition issues found in runtime/provider shape

## Current local run

The latest run sampled 127 downloaded datasets and emitted randomized sample
rows.
No live Cerebras call was made because `CEREBRAS_API_KEY` was not present in
the local environment.

The strongest sampled alignments were mostly tool/agent traces:

- `mobile-actions`
- `monodox-agent-tool-use`
- `deepfabric-github-mcp`
- `nemotron-rl-tool-use`
- `tool-reasoning-toucan`
- `qwen36-trajectory`
- `tool-call-ack-agent`

The weakest sources are mostly dialogue, pure reasoning, n8n template dumps,
or corpora where the first sampled rows do not expose tool-call fields.

## Runtime/provider findings

The audit intentionally compares generated target trajectories against the
actual current code paths. The important mismatches are:

- Newer real stages preserve `messages`, `tools`, `toolChoice`, `response`,
  `toolCalls`, `finishReason`, and `usage`; older recorder files may only
  preserve `prompt` and `response`.
- Stage 1 rows often use the native internal `MESSAGE_HANDLER_PLAN` tool with
  `toolChoice: required`; this is the best available routing supervision.
- `responseSchema`, `providerOptions`, and `providerMetadata` are absent in the
  sampled real runs. Do not synthesize those fields into bootstrap corpora.
- Usage/cache counters should be copied from live Eliza runs only. Missing
  usage/cache in bootstrap datasets is acceptable and should stay absent.

These are useful training-data constraints: generated rows should preserve the
current provider-visible shape for compatibility, while the transform metadata
should also mark where a row is only an approximation of the target v5
append-only message/context design.

## Transform implications

For each dataset transform, prefer preserving real observed structure over
over-inference:

- If a row has real tool calls, emit planner rows with native `toolCalls`.
- If a row has tool results or observations, also emit evaluator rows with
  inferred `success`, `decision`, and `thought`, marked as inferred.
- If a row only has user/assistant turns, emit message-handler or terminal
  planner `REPLY` rows, not fake tools.
- If contexts are absent, infer contexts from tool names, source family, and
  task text, and mark `quality.weaknesses` with `contexts inferred`.
- If cache observations are absent, leave cache metrics empty; do not invent
  provider cache usage.
- For multi-turn rows, preserve the full role sequence so User and Assistant
  turns remain visible in the same order the runtime would cache them.
- Every transform should ultimately write `eliza_native_v1`; the older
  `eliza.native_tool_calling.v1` bootstrap record is only an audit/transition
  shape and should not be fed directly to training.
