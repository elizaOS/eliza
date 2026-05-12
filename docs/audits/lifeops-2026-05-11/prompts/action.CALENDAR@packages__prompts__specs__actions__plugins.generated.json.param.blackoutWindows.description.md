# `action.CALENDAR@packages/prompts/specs/actions/plugins.generated.json.param.blackoutWindows.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 22
- **Last optimized**: never
- **Action**: CALENDAR
- **Parameter**: blackoutWindows (required: no)

## Current text
```
Array of { label, startLocal (HH:MM), endLocal (HH:MM), daysOfWeek? (0=Sun..6=Sat) }.
```

## Compressed variant
```
blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]
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
