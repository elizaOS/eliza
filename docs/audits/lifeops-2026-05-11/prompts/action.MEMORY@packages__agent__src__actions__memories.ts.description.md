# `action.MEMORY@packages/agent/src/actions/memories.ts.description`

- **Kind**: action-description
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/memories.ts:332`
- **Token count**: 55
- **Last optimized**: never
- **Action**: MEMORY
- **Similes**: CREATE_MEMORY, SEARCH_MEMORIES, UPDATE_MEMORY, DELETE_MEMORY, RECALL_MEMORY_FILTERED, FORGET_MEMORY, EDIT_MEMORY, MEMORIZE, REMEMBER_THIS, STORE_MEMORY, WRITE_MEMORY, SAVE_MEMORY, BROWSE_MEMORIES, FILTER_MEMORIES, FIND_MEMORIES, REMOVE_MEMORY, MODIFY_MEMORY

## Current text
```
Manage agent memory records. op:create stores a new memory; op:search filters by type/entityId/roomId/query; op:update edits text and re-embeds (requires confirm:true); op:delete removes a memory (requires confirm:true).
```

## Compressed variant
```
manage agent memory create search update delete; update/delete require confirm:true
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (83 chars vs 220 chars — 62% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
