# `action.CALENDAR@packages/prompts/specs/actions/plugins.generated.json.param.travelBufferMinutes.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 14
- **Last optimized**: never
- **Action**: CALENDAR
- **Parameter**: travelBufferMinutes (required: no)

## Current text
```
Minutes to reserve before/after each meeting (0–240).
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
