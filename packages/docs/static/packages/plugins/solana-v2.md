# Solana Plugin V2 for Eliza

## Purpose

Leverages the latest features of `@solana/web3.js` v2 to provide a modern, efficient, and composable solution for Solana integrations within the Eliza AI agent framework.

## Key Features

- Modern JavaScript and functional architecture using `@solana/web3.js` v2
- Compatibility with existing solana V1 plugins
- Common utilities including optimized transaction sending
- Trusted Execution Environment (TEE) support

## Integration

- Works within the Eliza AI agent framework
- Must be added to the `AgentRuntime` in `agent/src/index.ts`

## Current Functionality

- Orca liquidity position management
  - Automatically repositions liquidity positions based on price deviation thresholds
  - Maintains original position width
  - Repositions at user-defined intervals
  - Uses configurable slippage tolerance

## Example Usage

1. Set up environment variables (SOLANA_PRIVATE_KEY, SOLANA_PUBLIC_KEY, SOLANA_RPC_URL, OPENAI_API_KEY)
2. Update agent to include the plugin
3. Use LP Manager character
4. Run agent with: `bun start --characters="characters/lpmanager.character.json"`
5. Access web interface at localhost:3000

## Links

- [Transaction optimization details](https://orca-so.github.io/whirlpools/Whirlpools%20SDKs/Whirlpools/Send%20Transaction)
- [Transaction landing information](https://www.helius.dev/blog/how-to-land-transactions-on-solana#how-do-i-land-transactions)
