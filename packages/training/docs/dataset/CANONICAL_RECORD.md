# Canonical Eliza-1 training record: `eliza_native_v1`

This document declares the **one** canonical corpus record format for the
Eliza-1 fine-tuning pipeline and explains the two legitimate layers a record
passes through on its way to the trainer. If any script, schema, doc, or
dataset disagrees with this file, this file wins.

## TL;DR

- **Canonical corpus record = `eliza_native_v1`.** One row per Vercel AI SDK
  model-call boundary, carrying the exact request sent to the provider and the
  exact normalized response received. This is what the runtime trajectory
  exporter emits, what `eliza/plugins/app-training/datasets/lifeops_*.jsonl`
  trace files reduce to, and what `scripts/prepare_eliza1_trajectory_dataset.py`
  writes for the default `train/val/test` splits.
- **Rendered training example = ChatML SFT row.** `scripts/format_for_training.py`
  takes an `eliza_native_v1` corpus record and renders it into the
  `{ "messages": [...], "tools": [...] }` row that
  `tokenizer.apply_chat_template` actually consumes. That is a *rendering*, not
  a second source of truth.
- **`ElizaRecord` (flat `expectedResponse` shape) is DEPRECATED.** It is the
  legacy intermediate the old multi-dataset normalizer emitted
  (`scripts/lib/eliza_record.py`, `scripts/normalize.py`, `scripts/pack_dataset.py`).
  It is still accepted by `format_for_training.py` as a *legacy fallback* so the
  existing bulk corpus keeps loading, but no new code should target it and no
  new dataset should be authored in it.

## Two layers, on purpose

| Layer | What it is | Who produces it | Who consumes it |
| --- | --- | --- | --- |
| **Corpus record** | `eliza_native_v1` model-boundary row | runtime trajectory export, `prepare_eliza1_trajectory_dataset.py`, `privacy_filter_trajectories.py` | `format_for_training.py`, validators |
| **Training example** | ChatML `{messages, tools}` row | `format_for_training.py` (`format_record`) | `train_local.py` / `train_vast.sh` → `tokenizer.apply_chat_template` |

Keep these distinct. The corpus record is the durable, auditable artifact that
gets versioned, privacy-filtered, and published to HuggingFace. The training
example is an ephemeral derivation produced at train time and never persisted as
a primary dataset.

## The `eliza_native_v1` corpus record

A row is one model call recorded at the Vercel AI SDK boundary. The runtime
shape lives in TypeScript at
`eliza/packages/core/src/services/trajectory-types.ts`
(`ElizaNativeTrajectoryRow`, `ElizaNativeModelRequestRecord`,
`ElizaNativeModelResponseRecord`) and is written by
`eliza/packages/core/src/services/trajectory-recorder.ts`.

```jsonc
{
  "format": "eliza_native_v1",
  "schemaVersion": 1,
  "boundary": "vercel_ai_sdk.generateText",   // or "vercel_ai_sdk.streamText"
  "request": {
    "system": "string (optional)",
    "messages": [ /* AI-SDK chat messages: system|user|assistant|tool */ ],
    "prompt": "string (optional, used when messages is absent)",
    "tools": [ /* AI-SDK tool specs; the agent's exposed actions */ ],
    "toolChoice": "auto | none | required | { ... } (optional)",
    "responseSchema": { /* JSON schema for structured output (optional) */ },
    "settings": { "temperature": 0.0, "maxOutputTokens": 0, "topP": 1.0 }
  },
  "response": {
    "text": "string (always present; may be empty when only toolCalls)",
    "toolCalls": [
      { "toolCallId": "string", "toolName": "string", "input": { /* args */ } }
    ],
    "finishReason": "stop | tool_calls | length | content_filter | other",
    "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
    "providerMetadata": { /* opaque */ }
  },
  // identity + bookkeeping, copied from the flattened trajectory LLM-call row
  "trajectoryId": "string",
  "agentId": "string",
  "scenarioId": "string | null",
  "batchId": "string | null",
  "stepId": "string",
  "callId": "string",
  "stepIndex": 0,
  "callIndex": 0,
  "timestamp": 0,
  "metadata": { /* free-form; task_type, source_dataset, split, quality, ... */ }
}
```

### Minimal accepted shape

`format_for_training.py` only requires:

- `format == "eliza_native_v1"`
- `boundary` ∈ `{ "vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText" }`
- `request` is an object with either `messages` (containing at least one `user`
  turn) or `prompt`
- `response` is an object with non-empty `text` **or** at least one `toolCalls`
  entry

Everything else (`tools`, `system`, identity fields, `metadata`) is optional but
preserved when present. Native tool specs in `request.tools` are passed straight
through to the tokenizer's tool-rendering chat template.

### Native tool calls

The supervised assistant turn carries the live planner's native tool-call shape.
The planner emits JSON per `plannerSchema` in
`eliza/packages/core/src/prompts/planner.ts`:

```jsonc
{
  "thought": "string (required)",
  "toolCalls": [
    { "id": "string (optional)", "name": "ACTION_NAME", "args": { /* per-tool */ } }
  ],
  "messageToUser": "string (optional)"
}
```

When that surfaces at the model boundary, `response.toolCalls[].toolName` is the
**canonical** action name (e.g. `SHELL`, `TASKS`, `USE_SKILL`, `REPLY`). Removed
or renamed action names are rewritten to current names by
`prepare_eliza1_trajectory_dataset.py` using
`config/eliza1_action_aliases.json`. See that file plus
`eliza/packages/core/src/generated/action-docs.ts` for the live action catalog.

## The rendered ChatML training example

`format_for_training.format_record(record)` returns either a row ready for
`tokenizer.apply_chat_template` or `None` (the record was rejected — auxiliary
repair/eval rows, or it didn't match any accepted shape):

```jsonc
{
  "messages": [
    { "role": "system",    "content": "..." },
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "...", "tool_calls": [
      { "id": "call_0", "type": "function",
        "function": { "name": "SHELL", "arguments": "{\"command\":\"ls\"}" } }
    ] }
  ],
  "tools": [ /* OpenAI-style function specs, when the corpus record had request.tools */ ]
}
```

`arguments` is always a JSON string (OpenAI tool-call convention). Tool-result
turns become `{ "role": "tool", "tool_call_id": "...", "content": "..." }`.

## Accepted input shapes, ranked

`format_for_training.format_record` tries these in order. Only the first is
canonical; the rest are legacy fallbacks kept so the existing handoff files keep
loading. They will be removed once those corpora are regenerated as
`eliza_native_v1`.

1. **`eliza_native_v1`** — *canonical.* `_format_native_record`.
2. **`{ "messages": [...] }`** (optionally tagged
   `schema == "eliza.eliza1_trajectory_record.v1"`, optional `tools`) —
   pre-rendered ChatML SFT rows, e.g. the `lifeops_*.jsonl` trace files and the
   trajectory-record output of `prepare_eliza1_trajectory_dataset.py --output-format trajectory-record`.
   *Legacy/derived.* `_format_messages_record`.
3. **Flat `ElizaRecord`** — `{ roomName, agentId, memoryEntries, currentMessage,
   expectedResponse, availableActions, metadata }` from `scripts/normalize.py` →
   `scripts/pack_dataset.py`. **DEPRECATED.** `_format_legacy_flat_record`.

Auxiliary rows (split ∈ `{repair, repair_eval}`, or `quality.success == false`,
or `quality.requiresRepair == true`, or `quality.rating == "repair"`) are
rejected by every path on purpose — they are repair-loop fodder, not training
data.

## Related schemas

- `config/native_tool_calling_record.schema.json` — JSON Schema for native
  tool-calling SFT records by stage (`message_handler`, `planner`, ...). Its
  `plannerOutput` mirrors the live `plannerSchema` above.
- `config/eliza1_trajectory_record.schema.json` — JSON Schema for the *derived*
  ChatML SFT record (`eliza.eliza1_trajectory_record.v1`) produced by
  `prepare_eliza1_trajectory_dataset.py --output-format trajectory-record`. This
  is the persisted form of layer-2 (rendered training example) with extra
  source/quality metadata; it is **not** the canonical corpus record.
- `config/eliza1_action_aliases.json` — removed/renamed action name → current
  canonical name mapping, applied during trajectory dataset preparation.

## What not to do

- Don't author a new dataset in the flat `ElizaRecord` shape.
- Don't add a new "intermediate" record format. Two layers, that's it.
- Don't persist the rendered ChatML example as a primary corpus artifact — it is
  derived from `eliza_native_v1` and regenerated at train time.
- Don't reference removed actions (`RUN_SKILL_SCRIPT`, `GET_SKILL_GUIDANCE`,
  `SHELL_COMMAND`, `SPAWN_AGENT`, `SEND_TO_AGENT`, `STOP_AGENT`, `TASK_CONTROL`,
  `TASK_HISTORY`, `TASK_SHARE`, `TASK_CALL`) in new config or synthesized data —
  use the canonical names (`USE_SKILL`, `SHELL`, `TASKS`).
