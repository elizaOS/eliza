# `action.TODO@plugins/plugin-todos/src/actions/todo.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-todos
- **File**: `plugins/plugin-todos/src/actions/todo.ts:490`
- **Token count**: 71
- **Last optimized**: never
- **Action**: TODO
- **Similes**: TODO_WRITE, WRITE_TODOS, SET_TODOS, UPDATE_TODOS, TODO_CREATE, CREATE_TODO, TODO_UPDATE, UPDATE_TODO, TODO_COMPLETE, COMPLETE_TODO, FINISH_TODO, TODO_CANCEL, CANCEL_TODO, TODO_DELETE, DELETE_TODO, REMOVE_TODO, TODO_LIST, LIST_TODOS, GET_TODOS, SHOW_TODOS, TODO_CLEAR, CLEAR_TODOS

## Current text
```
Manage the user's todo list. Actions: write (replace the list with `todos:[{id?, content, status, activeForm?}]`), create (add one), update (change by id), complete, cancel, delete, list, clear. Todos are user-scoped (entityId), persistent, and shared across rooms for the same user.
```

## Compressed variant
```
todos: write|create|update|complete|cancel|delete|list|clear; user-scoped (entityId)
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (84 chars vs 283 chars — 70% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
