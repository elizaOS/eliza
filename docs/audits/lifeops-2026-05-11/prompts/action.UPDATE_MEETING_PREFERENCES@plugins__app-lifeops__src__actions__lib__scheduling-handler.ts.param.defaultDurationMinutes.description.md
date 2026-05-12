# `action.UPDATE_MEETING_PREFERENCES@plugins/app-lifeops/src/actions/lib/scheduling-handler.ts.param.defaultDurationMinutes.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:841`
- **Token count**: 11
- **Last optimized**: never
- **Action**: UPDATE_MEETING_PREFERENCES
- **Parameter**: defaultDurationMinutes (required: no)

## Current text
```
Default meeting duration in minutes (5–480).
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 15
- Success rate: 0.73
- Avg input chars when matched: 61213

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
