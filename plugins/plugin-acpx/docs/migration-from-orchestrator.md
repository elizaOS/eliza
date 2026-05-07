# Migrating from plugin-agent-orchestrator spawn actions

`@elizaos/plugin-acpx` replaces the PTY-backed code-agent spawn surface in `@elizaos/plugin-agent-orchestrator` with Agent Client Protocol subprocess sessions.

## Why migrate

The orchestrator spawn actions drive coding agents through PTYs, terminal escape sequences, and prompt matching. Those integrations are brittle when Codex, Claude, or Gemini update their terminal UI. ACPX speaks Agent Client Protocol JSON-RPC events directly, including `tool_call`, `tool_call_update`, `agent_message_chunk`, `session/load`, and `session/cancel`.

## Setup

1. Install the ACPX CLI:

   ```sh
   npm install -g acpx@latest
   ```

2. Configure the plugin:

   ```sh
   ELIZA_ACP_CLI=acpx
   ACPX_FORMAT=json
   ACPX_NO_TERMINAL=true
   # Optional:
   ACPX_DEFAULT_CWD=/path/to/workspace
   ACPX_DEFAULT_TIMEOUT_MS=600000
   ACPX_APPROVE_ALL=false
   ```

3. Add `@elizaos/plugin-acpx` to your character/plugin list.
4. Remove direct imports of `plugin-agent-orchestrator` spawn-side actions after you migrate callers.

## Action mapping

| plugin-agent-orchestrator | plugin-acpx replacement | Notes |
| --- | --- | --- |
| `spawnAgentAction` / `spawnTaskAgentAction` | `spawnAgentAction` / `spawnTaskAgentAction` | Starts a recoverable ACP subprocess session. Accepts similar `task`, `agentType`, `workdir`, `model`, and `approvalPreset` fields. |
| `sendToAgentAction` / `sendToTaskAgentAction` | `sendToAgentAction` / `sendToTaskAgentAction` | Sends follow-up input to an existing ACP session. |
| `stopAgentAction` / `stopTaskAgentAction` | `stopAgentAction` / `stopTaskAgentAction`, `cancelTaskAction` | Uses cooperative ACP cancellation/close semantics instead of terminal signals. |
| `listAgentsAction` / `listTaskAgentsAction` | `listAgentsAction` / `listTaskAgentsAction` | Lists known ACP sessions, status, workspace, and agent metadata. |
| `taskControlAction` | ACP session control via `sendToAgentAction`, `stopAgentAction`, `cancelTaskAction` | Prefer explicit session actions. |
| `taskHistoryAction` | ACP session history/listing via `availableAgentsProvider` and session store | Session recovery uses ACPX records and persisted session metadata. |
| `startCodingTaskAction` | `startCodingTaskAction` / `createTaskAction` | High-level task creation over ACPX. |

## Main shape differences

- Session ids identify ACPX-managed sessions rather than PTY processes.
- Cancellation is cooperative through ACP when possible.
- Output is based on structured ACP events, not scraped terminal buffers.
- Parallel sessions in one workspace are first-class and do not need separate terminal state machines.

## Compatibility window

The orchestrator actions remain functional for now and log a deprecation warning when invoked. They are expected to be removed after roughly one release cycle once callers migrate to `@elizaos/plugin-acpx`.
