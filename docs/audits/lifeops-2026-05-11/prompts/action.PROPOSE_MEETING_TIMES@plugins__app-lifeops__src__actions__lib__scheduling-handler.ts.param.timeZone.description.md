# `action.PROPOSE_MEETING_TIMES@plugins/app-lifeops/src/actions/lib/scheduling-handler.ts.param.timeZone.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:447`
- **Token count**: 30
- **Last optimized**: never
- **Action**: PROPOSE_MEETING_TIMES
- **Parameter**: timeZone (required: no)

## Current text
```
Optional IANA time zone override when the user is temporarily traveling and wants proposals shown in that local time.
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
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
