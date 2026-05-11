# `action.SETTLE_PAYMENT@packages/core/src/features/payments/actions/settle-payment.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/payments/actions/settle-payment.ts:36`
- **Token count**: 37
- **Last optimized**: never
- **Action**: SETTLE_PAYMENT
- **Similes**: FINALIZE_PAYMENT, CONFIRM_PAYMENT

## Current text
```
Explicitly settle a payment request via the runtime payment settler. Used for providers that do not deliver webhook callbacks (e.g. wallet_native).
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
