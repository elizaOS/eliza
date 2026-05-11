# `action.SCHEDULED_TASKS@plugins/app-lifeops/src/actions/scheduled-task.ts.param.promptInstructions.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/scheduled-task.ts:592`
- **Token count**: 13
- **Last optimized**: never
- **Action**: SCHEDULED_TASKS
- **Parameter**: promptInstructions (required: no)

## Current text
```
create-only: prompt instructions stored on the task.
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
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
