# Native source transforms

This document is the checked-in summary of the native bootstrap transform
families. The exhaustive per-source matrix is generated at
`data/native/SOURCE_MATRIX.md` by:

```bash
uv run python scripts/prepare_native_tool_calling_data.py --write-matrix
```

## Transform families

| Transform | Native stages | Source families | Strength | Weakness |
| --- | --- | --- | --- | --- |
| `eliza_record_compat` | `message_handler`, `planner`, `evaluator` | ScamBench / existing ElizaRecord rows | Already closest to runtime semantics | Legacy outputs still need TOON compatibility reads |
| `eliza_trajectory_compat` | `message_handler`, `planner`, `trajectory` | Nubilio | Real deployed trajectories | Local corpus required; mixed XML/YAML/JSON/TOON inputs |
| `scam_defense_to_planner_and_evaluator` | `message_handler`, `planner`, `evaluator` | Scam-defense corpus | Strong safety/evaluator signal | Local corpus required; some labels inferred |
| `dialogue_routing_to_message_handler` | `message_handler`, `planner` | LIGHT/multilight | Good Stage 1 routing signal | No tool execution signal |
| `function_calling_to_planner` | `planner` | Hermes, Glaive, BitAgent, Functions-53K, Dolci | Clear native tool names and args | Usually single-turn; no evaluator result |
| `multi_hop_tools_to_planner` | `planner`, `sub_planner` | ToolHop | Queued/multi-hop tool calls | Tool results vary by source |
| `agentic_tool_trace_to_planner` | `planner`, `sub_planner`, sometimes `trajectory` | Nemotron, Qwen trajectories | Chained planning supervision | Evaluator decisions are not Eliza-native |
| `coding_tool_trace_to_planner` | `planner`, `sub_planner` | coding and terminal traces | Strong code/tool workflows | Can over-weight code/terminal contexts |
| `mcp_specs_to_planner` | `planner`, `sub_planner` | MCP-Flow | Good native schema material | Often specs instead of executions |
| `mcp_messages_to_planner` | `planner`, `sub_planner` | MCP message corpora | Connector/tool routing signal | Server and tool names need normalization |
| `terminal_trace_to_planner` | `planner`, `sub_planner` | terminal corpora | Shell-command supervision | Must be role-gated to terminal/code contexts |
| `dialogue_to_message_handler` | `message_handler`, `planner` | Discord/Telegram/multiparty dialogue | Natural dialogue variety | Routing/tool labels are inferred |
| `distill_reply_to_planner_reply` | `planner` | Claude distills | High-quality direct answers | Raw thinking format is out of runtime distribution |
| `reasoning_to_reply_quarantine` | `planner` | pure reasoning/COT | Optional warmup material | Not part of normal runtime; excluded by default |
| `n8n_workflow_to_automation_tool` | `planner`, `sub_planner` | n8n workflow corpora | Workflow JSON can seed automation tool data | Not a normal chat-loop output; excluded by default |
| `abliteration_quarantine` | `planner` or `evaluator` | harmful/harmless calibration | Useful for separate ablation/refusal work | Must not enter main SFT |

## Default inclusion rule

Only `gold`, `silver`, and selected `bronze` rows enter the default native SFT
mix. `quarantine` rows are written only with `--include-quarantine` and carry
`recommendedWeight: 0.0`.

Generated source rows also include raw availability:

- `downloaded`: raw data is present with `.done`.
- `partial`: raw directory exists but `.done` is missing.
- `not_downloaded`: not pulled yet or failed to pull.
- `local_missing`: `datasets.yaml` points at a local corpus that is absent.

## Current bootstrap path

Legacy normalized rows are converted by
`scripts/prepare_native_tool_calling_data.py --transform-normalized`. New
adapters should bypass `expectedResponse` and TOON entirely and emit
`NATIVE_TOOL_CALLING_SPEC.md` rows directly.
