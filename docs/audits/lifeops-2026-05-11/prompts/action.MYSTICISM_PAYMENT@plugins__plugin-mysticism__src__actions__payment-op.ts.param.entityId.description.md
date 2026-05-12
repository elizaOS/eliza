# `action.MYSTICISM_PAYMENT@plugins/plugin-mysticism/src/actions/payment-op.ts.param.entityId.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-mysticism
- **File**: `plugins/plugin-mysticism/src/actions/payment-op.ts:44`
- **Token count**: 28
- **Last optimized**: never
- **Action**: MYSTICISM_PAYMENT
- **Parameter**: entityId (required: no)

## Current text
```
For check — optional entity id whose active reading payment should be checked. Defaults to the current sender.
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
