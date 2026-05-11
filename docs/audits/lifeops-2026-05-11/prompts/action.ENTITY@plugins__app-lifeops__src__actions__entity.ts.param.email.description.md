# `action.ENTITY@plugins/app-lifeops/src/actions/entity.ts.param.email.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/entity.ts:447`
- **Token count**: 10
- **Last optimized**: never
- **Action**: ENTITY
- **Parameter**: email (required: no)

## Current text
```
Optional email address for the contact.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 41
- Success rate: 0.90
- Avg input chars when matched: 62327

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
