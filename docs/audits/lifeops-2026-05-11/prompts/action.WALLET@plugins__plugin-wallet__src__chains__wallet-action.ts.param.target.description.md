# `action.WALLET@plugins/plugin-wallet/src/chains/wallet-action.ts.param.target.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-wallet
- **File**: `plugins/plugin-wallet/src/chains/wallet-action.ts:393`
- **Token count**: 45
- **Last optimized**: never
- **Action**: WALLET
- **Parameter**: target (required: no)

## Current text
```
Chain id/name for write ops (source chain for bridge); analytics provider for token_info (dexscreener, birdeye, coingecko). Omit only when one handler/provider supports the action.
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
