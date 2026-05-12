# `action.RUNTIME@packages/agent/src/actions/runtime.ts.description`

- **Kind**: action-description
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/runtime.ts:450`
- **Token count**: 114
- **Last optimized**: never
- **Action**: RUNTIME
- **Similes**: GET_RUNTIME_STATUS, LIST_ACTIONS, DESCRIBE_REGISTERED_ACTIONS, RELOAD_RUNTIME_CONFIG, RESTART_RUNTIME, RESTART_AGENT, GET_SELF_STATUS, RUNTIME_STATUS, AGENT_STATUS_RUNTIME, RUNTIME_SNAPSHOT, REGISTERED_ACTIONS, AVAILABLE_ACTIONS, RELOAD_CONFIG, REFRESH_CONFIG, RESTART_PROCESS, RELOAD_RUNTIME, BOUNCE_RUNTIME, RESTART, REBOOT, RELOAD, REFRESH, RESPAWN, RESTART_SELF, REBOOT_AGENT, RELOAD_AGENT, CHECK_STATUS, SELF_STATUS, MY_STATUS, SYSTEM_STATUS, CHECK_SELF

## Current text
```
Polymorphic runtime control. action=status snapshots registered actions/providers/services; action=self_status returns Layer-2 awareness detail for a module (runtime, permissions, wallet, provider, pluginHealth, connectors, cloud, features); action=describe_actions lists registered actions, optionally filtered; action=reload_config re-applies hot-reloadable fields from eliza.json; action=restart bounces the process via the registered RestartHandler.
```

## Compressed variant
```
polymorphic runtime control: status, self_status, describe_actions, reload_config, restart
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (90 chars vs 453 chars — 80% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
