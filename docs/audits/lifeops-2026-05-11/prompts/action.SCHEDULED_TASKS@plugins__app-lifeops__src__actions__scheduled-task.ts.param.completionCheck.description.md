# `action.SCHEDULED_TASKS@plugins/app-lifeops/src/actions/scheduled-task.ts.param.completionCheck.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/scheduled-task.ts:592`
- **Token count**: 33
- **Last optimized**: never
- **Action**: SCHEDULED_TASKS
- **Parameter**: completionCheck (required: no)

## Current text
```
create-only: structural completion check such as user_replied_within, user_acknowledged, subject_updated, or health_signal_observed.
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
