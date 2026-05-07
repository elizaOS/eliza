# Native trajectory alignment audit

This audit checks whether downloaded bootstrap corpora can be transformed into
the v5 native runtime shape:

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
  --samples-per-source 3 --run-cerebras
```

If `CEREBRAS_API_KEY` is set, the reference model stages call Cerebras
`gpt-oss-120b`. If the key is absent, the script still writes deterministic
offline fixtures and marks `modelRun.mode = offline_fixture`.

## Outputs

All outputs live under ignored local data:

- `data/native/audit/dataset_samples.jsonl`
  - exactly three rows per downloaded dataset
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
- `data/native/audit/composition_audit.md`
  - summary table plus composition issues found in runtime/provider shape

## Current local run

The latest run sampled 127 downloaded datasets and emitted 381 sample rows.
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

- Stage 1, planner, and evaluator render one large `prompt` string today.
  Planner/evaluator do not pass `messages` or `promptSegments` into
  `runtime.useModel`, so provider-visible inputs are not yet the ideal
  append-only chat-message shape.
- Planner has a schema in `v5PlannerSchema`, but the current planner call does
  not pass `responseSchema`; it relies on native tool calls when tools exist
  or parses JSON from returned text otherwise.
- Evaluator has `v5EvaluatorSchema`, but the current evaluator call does not
  pass `responseSchema`.
- `renderContextObject()` computes segment hashes for recorder/cache
  diagnostics, but those prompt segments are not passed through to model
  adapters on planner/evaluator calls.
- The cloud Vercel AI Gateway bridge maps OpenAI-style chat messages into AI
  SDK `ModelMessage` and maps assistant tool calls/tool results correctly, but
  the OpenAI-compatible usage response currently drops AI SDK cache read/write
  token details.
- The cloud Vercel AI Gateway structured-output bridge currently accepts a
  broad `{type: object, additionalProperties: true}` schema instead of the
  caller's exact response schema.

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
