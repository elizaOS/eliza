# `action.VERIFY_PAYMENT_PAYLOAD@packages/core/src/features/payments/actions/verify-payment-payload.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/payments/actions/verify-payment-payload.ts:36`
- **Token count**: 37
- **Last optimized**: never
- **Action**: VERIFY_PAYMENT_PAYLOAD
- **Similes**: VERIFY_PAYMENT_PROOF, CHECK_PAYMENT_PROOF

## Current text
```
Verify an inbound payment proof (e.g. x402 header, wallet signature) for a stored payment request. Returns validity only — never echoes the proof.
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
