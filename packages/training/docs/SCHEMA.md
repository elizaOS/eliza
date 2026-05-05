# Canonical normalized record schema

Every adapter in `scripts/lib/adapters.py` emits the **canonical eliza shape**,
identical to the `eliza` config that ScamBench publishes. No extra
top-level fields — adapter-specific extras live under `metadata`.

```jsonc
{
  "roomName":         "string  (used as stable id; must be unique)",
  "agentId":          "string  (the agent's id within the conversation)",
  "memoryEntries":    [{"role":"user|assistant|system|tool",
                         "speaker":"string",
                         "content":"string",
                         "channel":"dm|public|tool|system"}],
  "currentMessage":   {"role":"user", "speaker":"string", "content":"string",
                         "channel":"dm|public"},
  "expectedResponse": "string  — the supervised target. TOON-encoded for
                                   structured tasks (routing, tool calls,
                                   shell commands), plain text only for
                                   reasoning-distill records that ship a
                                   raw <think>...</think>final envelope.",
  "availableActions": ["RESPOND" | "IGNORE" | "STOP" | "REPLY"
                         | "SHELL_COMMAND" | "TASK_CALL"
                         | "MUTE_ROOM" | "UNMUTE_ROOM"
                         | "FOLLOW_ROOM" | "UNFOLLOW_ROOM"
                         | <custom>],
  "metadata":         { ... }   // see below
}
```

## metadata (required keys + commonly-used extras)

Required (enforced by `ElizaRecord.is_valid()` in `scripts/lib/eliza_record.py`
and re-checked by `scripts/jsonl_to_parquet.py:normalize_record`):

- `task_type` — selects the eliza prompt template the trainer renders into
  the system message at training time. One of:
  `should_respond`, `should_respond_with_context`, `should_mute_room`,
  `should_unmute_room`, `should_follow_room`, `should_unfollow_room`,
  `reply`, `tool_call`, `shell_command`, `mcp_tool_call`, `mcp_routing`,
  `scam_defense`, `mobile_action`, `agent_trace`, `reasoning_cot`,
  `dialogue_routing`, `claude_distill`, `n8n_workflow_generation`,
  `reflection`, `reflection_evaluator`, ...
- `source_dataset` — origin slug (e.g. `scambench`, `hermes-fc-v1`,
  `discord-chat`, `synth-eliza-prompts`).
- `license` — best-effort license string from the source.
- `split` — `train` | `validation` | `test`.

Common extras:

- `language`, `scenario_category`, `original_id`
- `system_prompt` — when the adapter has an authoritative per-record system
  prompt to carry through; `format_for_training.system_prompt_for(...)`
  prefers this over the task-type registry template.
- `toolSpecs` — list of `{name, description, parameters}` objects when the
  task is `tool_call`/`mcp_tool_call`. The trainer injects these into the
  system message so the student sees the tool spec.
- `synth_task`, `teacher_model` — for synthesized records.
- `dialogue_clue` — `mention | name_token | injected_name | ping | none` for
  records produced by `dialogue_routing`.

## expectedResponse encodings (by task_type)

The canonical structured-task envelope is the **planner envelope** — five
keys: `thought`, `actions[N]{name,params}`, `providers`, `text`, `simple`.
Tool calls ride under `actions[].params.{tool, arguments}` and shell
commands under `actions[].params.{command, cwd, explanation}` so every
agent-side decision shares one schema. Routing (`should_respond`),
reflection, and distill records use task-specific shapes.

| task_type                     | expectedResponse format                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `should_respond`              | TOON: `name`, `reasoning`, `action: RESPOND\|IGNORE\|STOP`, `primaryContext`, `secondaryContexts`, `evidenceTurnIds` |
| `should_respond_with_context` | same shape as `should_respond`                                                                |
| `should_mute_room`            | TOON: `decision: true\|false`                                                                 |
| `should_unmute_room`          | TOON: `decision: true\|false`                                                                 |
| `should_follow_room`          | TOON: `decision: true\|false`                                                                 |
| `should_unfollow_room`        | TOON: `decision: true\|false`                                                                 |
| `reply`                       | TOON planner envelope (`thought`, `actions[1]: REPLY`, `providers`, `text`, `simple`) — older records may carry the slim `thought, text` shape, both accepted by `audit_pipeline_shapes.py:validate_reply` |
| `tool_call` / `mcp_tool_call` | TOON planner envelope; tool calls are `actions[N]{name: TASK_CALL, params: {tool, arguments}}` |
| `mcp_routing`                 | TOON: `server`, `tool`, `arguments`                                                           |
| `shell_command`               | TOON planner envelope; `actions[1]{name: SHELL_COMMAND, params: {command, cwd, explanation}}` |
| `scam_defense`                | TOON planner envelope (REPLY for engage/verify/decline; IGNORE for block)                     |
| `dialogue_routing`            | TOON: `name`, `reasoning`, `action: RESPOND\|IGNORE`                                          |
| `agent_trace`                 | TOON planner envelope                                                                         |
| `mobile_action`               | TOON planner envelope                                                                         |
| `n8n_workflow_generation`     | TOON planner envelope; the workflow JSON rides under `actions[1].params.workflow`             |
| `reflection`                  | TOON: `thought`, `task_completed: bool`, `task_completion_reason`                             |
| `reasoning_cot`               | TOON: `thought, text` (slim) or full planner envelope                                         |
| `claude_distill`              | RAW: `<think>{reasoning}</think>{final answer}` — preserved verbatim from the Claude distill source so the model learns the same `<think>` envelope that Qwen3.6 / Qwopus emit at inference. NOT TOON-encoded. |

`scripts/audit_pipeline_shapes.py` validates each record against the
schema for its `task_type` and writes `previews/PIPELINE_AUDIT.md` —
treat that report, not this document, as the runtime source of truth
when investigating drift.

## Why flat?

The user's training corpus must be drop-in compatible with the existing
`eliza` config consumers (and, by extension, anyone using
`load_dataset("shaw/scambench-training", "eliza")`). Carrying extra
top-level fields would diverge the published shape, force consumers to
strip them, and confuse the elizaOS runtime which expects the canonical
keys. All adapter-specific information rides under `metadata`.

## TOON encoding

`expectedResponse` for structured tasks is encoded by
`tools/toon_encode.mjs` (Bun, backed by `@toon-format/toon`) so it is
byte-identical to what the elizaOS runtime decoder expects.
