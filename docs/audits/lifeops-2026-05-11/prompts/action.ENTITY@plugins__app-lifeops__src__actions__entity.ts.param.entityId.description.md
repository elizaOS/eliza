# `action.ENTITY@plugins/app-lifeops/src/actions/entity.ts.param.entityId.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/entity.ts:447`
- **Token count**: 39
- **Last optimized**: never
- **Action**: ENTITY
- **Parameter**: entityId (required: no)

## Current text
```
Target entity id. Used by set_identity (force a new identity onto a known entity), merge (target id), and any operation that needs a stable EntityStore id.
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
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
