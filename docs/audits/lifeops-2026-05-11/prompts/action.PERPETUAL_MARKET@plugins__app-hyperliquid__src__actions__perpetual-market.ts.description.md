# `action.PERPETUAL_MARKET@plugins/app-hyperliquid/src/actions/perpetual-market.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-hyperliquid
- **File**: `plugins/app-hyperliquid/src/actions/perpetual-market.ts:704`
- **Token count**: 75
- **Last optimized**: never
- **Action**: PERPETUAL_MARKET

## Current text
```
Use registered perpetual market providers. target selects the provider; Hyperliquid is registered today. action=read reads public state with kind: status, markets, market, positions, or funding. action=place_order reports trading readiness; signed order placement is disabled in this app scaffold.
```

## Compressed variant
```
Perpetual market router: target hyperliquid; action read or place_order.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (72 chars vs 297 chars — 76% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
