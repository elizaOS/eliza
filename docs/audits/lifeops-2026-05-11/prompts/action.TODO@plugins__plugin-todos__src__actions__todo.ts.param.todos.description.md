# `action.TODO@plugins/plugin-todos/src/actions/todo.ts.param.todos.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-todos
- **File**: `plugins/plugin-todos/src/actions/todo.ts:454`
- **Token count**: 28
- **Last optimized**: never
- **Action**: TODO
- **Parameter**: todos (required: no)

## Current text
```
Array of {id?, content, status, activeForm?} for action=write. Replaces the user's list for this conversation.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
