# `action.LIQUIDITY@plugins/plugin-wallet/src/lp/actions/liquidity.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-wallet
- **File**: `plugins/plugin-wallet/src/lp/actions/liquidity.ts:598`
- **Token count**: 65
- **Last optimized**: never
- **Action**: LIQUIDITY
- **Similes**: LP_MANAGEMENT, LIQUIDITY_POOL_MANAGEMENT, LP_MANAGER, MANAGE_LP, MANAGE_LIQUIDITY, MANAGE_LP_POSITIONS, AUTOMATE_REBALANCING, AUTOMATE_POSITIONS, START_MANAGING_POSITIONS, AUTOMATE_RAYDIUM_REBALANCING, AUTOMATE_RAYDIUM_POSITIONS, START_MANAGING_RAYDIUM_POSITIONS

## Current text
```
Single LP/liquidity management action. action=onboard|list_pools|open|close|reposition|list_positions|get_position|set_preferences. dex=orca|raydium|meteora|uniswap|aerodrome|pancakeswap selects the protocol; chain=solana|evm is inferred from dex when omitted.
```

## Compressed variant
```
Manage LP positions by action, chain, dex, pool, position, amount, range, token filters.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (88 chars vs 260 chars — 66% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
