# `action.CALENDAR@packages/prompts/specs/actions/plugins.generated.json.param.preferredStartLocal.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 16
- **Last optimized**: never
- **Action**: CALENDAR
- **Parameter**: preferredStartLocal (required: no)

## Current text
```
Earliest preferred meeting start time-of-day (local HH:MM, 24h).
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 52
- Success rate: 0.92
- Avg input chars when matched: 67632

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
