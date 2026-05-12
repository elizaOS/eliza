# `action.SCHEDULED_TASKS@plugins/app-lifeops/src/actions/scheduled-task.ts.param.action.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/scheduled-task.ts:592`
- **Token count**: 37
- **Last optimized**: never
- **Action**: SCHEDULED_TASKS
- **Parameter**: action (required: no)

## Current text
```
Which scheduled-task operation to run: list | get | create | update | snooze | skip | complete | acknowledge | dismiss | cancel | reopen | history.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 33
- Success rate: 0.88
- Avg input chars when matched: 58493

## Sample failure transcripts
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
