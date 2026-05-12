# `action.TRUST@packages/core/src/features/trust/actions/trust.ts.param.entityName.description`

- **Kind**: action-parameter
- **Owner**: packages/core
- **File**: `packages/core/src/features/trust/actions/trust.ts:118`
- **Token count**: 29
- **Last optimized**: never
- **Action**: TRUST
- **Parameter**: entityName (required: no)

## Current text
```
Optional target entity name (evaluate). Name-only lookups return a bounded failure; provide entityId where possible.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
