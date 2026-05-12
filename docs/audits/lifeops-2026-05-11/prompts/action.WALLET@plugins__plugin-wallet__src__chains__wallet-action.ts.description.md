# `action.WALLET@plugins/plugin-wallet/src/chains/wallet-action.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-wallet
- **File**: `plugins/plugin-wallet/src/chains/wallet-action.ts:394`
- **Token count**: 96
- **Last optimized**: never
- **Action**: WALLET
- **Similes**: SWAP, SWAP_SOLANA, TRANSFER, TRANSFER_TOKEN, WALLET_SWAP, WALLET_TRANSFER, CROSS_CHAIN_TRANSFER, PREPARE_TRANSFER, WALLET_ACTION, WALLET_GOV, TOKEN_INFO, BIRDEYE_LOOKUP, BIRDEYE_SEARCH, WALLET_SEARCH_ADDRESS

## Current text
```
Route wallet operations through registered chain handlers and analytics providers. Use action=transfer|swap|bridge|gov for on-chain ops (params: chain, toChain, fromToken, toToken, amount, recipient, slippageBps, mode, dryRun); action=token_info for token/market data (params: target, query, address, chain); action=search_address for Birdeye wallet/portfolio lookup (param: address).
```

## Compressed variant
```
WALLET umbrella: action=transfer|swap|bridge|gov (chain ops) | token_info (market data) | search_address (Birdeye portfolio).
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (125 chars vs 384 chars — 67% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
