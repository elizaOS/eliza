# `action.AWAIT_PAYMENT_CALLBACK@packages/core/src/features/payments/actions/await-payment-callback.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/payments/actions/await-payment-callback.ts:38`
- **Token count**: 36
- **Last optimized**: never
- **Action**: AWAIT_PAYMENT_CALLBACK
- **Similes**: WAIT_FOR_PAYMENT, AWAIT_PAYMENT_SETTLEMENT

## Current text
```
Wait for an asynchronous payment settlement callback. Default timeout: 10 minutes. Returns settlement status only — raw proof is never surfaced.
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
