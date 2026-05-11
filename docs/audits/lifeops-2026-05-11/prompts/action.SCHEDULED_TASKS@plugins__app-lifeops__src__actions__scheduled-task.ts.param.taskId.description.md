# `action.SCHEDULED_TASKS@plugins/app-lifeops/src/actions/scheduled-task.ts.param.taskId.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/scheduled-task.ts:592`
- **Token count**: 29
- **Last optimized**: never
- **Action**: SCHEDULED_TASKS
- **Parameter**: taskId (required: no)

## Current text
```
Target taskId for get / update / snooze / skip / complete / acknowledge / dismiss / cancel / reopen / history.
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
