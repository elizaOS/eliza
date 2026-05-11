# `action.LOGS@packages/agent/src/actions/logs.ts.description`

- **Kind**: action-description
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/logs.ts:268`
- **Token count**: 58
- **Last optimized**: never
- **Action**: LOGS
- **Similes**: SEARCH_LOGS, DELETE_LOGS, LOG_LEVEL, QUERY_LOGS, READ_LOGS, GET_LOGS, INSPECT_LOGS, VIEW_LOGS, LOOKUP_LOGS, CLEAR_LOGS, WIPE_LOGS, RESET_LOGS, EMPTY_LOGS, SET_LOG_LEVEL, CHANGE_LOG_LEVEL, DEBUG_MODE, SET_DEBUG, CONFIGURE_LOGGING

## Current text
```
Polymorphic log control: action='search' tails the in-memory log buffer (filterable by source/level/tag/since), action='delete' clears that buffer, action='set_level' overrides the per-room log level (trace/debug/info/warn/error).
```

## Compressed variant
```
search/delete in-mem agent logs or set_level per-room owner-only
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (64 chars vs 230 chars — 72% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
