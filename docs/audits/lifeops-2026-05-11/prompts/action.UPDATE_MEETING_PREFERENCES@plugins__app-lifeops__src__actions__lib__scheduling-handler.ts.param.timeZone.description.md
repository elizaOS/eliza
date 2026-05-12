# `action.UPDATE_MEETING_PREFERENCES@plugins/app-lifeops/src/actions/lib/scheduling-handler.ts.param.timeZone.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:841`
- **Token count**: 13
- **Last optimized**: never
- **Action**: UPDATE_MEETING_PREFERENCES
- **Parameter**: timeZone (required: no)

## Current text
```
IANA time zone used to interpret preferred hours.
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
