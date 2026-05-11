# `action.SHOPIFY@plugins/plugin-shopify/src/actions/shopify.ts.param.action.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-shopify
- **File**: `plugins/plugin-shopify/src/actions/shopify.ts:109`
- **Token count**: 30
- **Last optimized**: never
- **Action**: SHOPIFY
- **Parameter**: action (required: no)

## Current text
```
Operation to perform. One of: search, products, inventory, orders, customers. Inferred from message text when omitted.
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
