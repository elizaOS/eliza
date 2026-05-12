# `action.WORK_THREAD@plugins/app-lifeops/src/actions/work-thread.ts.param.operations.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/work-thread.ts:290`
- **Token count**: 46
- **Last optimized**: never
- **Action**: WORK_THREAD
- **Parameter**: operations (required: yes)

## Current text
```
Array of thread lifecycle operations. Each item has type, optional workThreadId, sourceWorkThreadIds, instruction, reason, title, summary, sourceRef, and trigger for schedule_followup.
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
