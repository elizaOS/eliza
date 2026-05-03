# elizaos-plugin-agentwallet

Non-custodial wallet plugin for ElizaOS agents. EVM + Solana, x402 micropayments, CCTP cross-chain bridge, Jupiter and Uniswap swaps — and your agent holds its own private key the entire time.

## Why non-custodial matters

Most agent wallet setups proxy through a vendor. Your agent calls Coinbase's API. Privy holds the key. The agent is asking permission to spend its own money.

This plugin skips all that. The key lives in the agent's settings. Every transaction gets signed locally. There's no CDP API key, no Privy account, no custody layer between your agent and its funds.

## Install

```bash
npm install elizaos-plugin-agentwallet agentwallet-sdk
```

## Quick start

```typescript
import { createAgent } from '@elizaos/core';
import agentWalletPlugin from 'elizaos-plugin-agentwallet';

const agent = await createAgent({
  plugins: [agentWalletPlugin],
  settings: {
    // EVM setup (Base mainnet)
    AGENTWALLET_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY,
    AGENTWALLET_CHAIN: 'evm',
    AGENTWALLET_EVM_NETWORK: 'base',
    AGENTWALLET_SPEND_LIMIT_USD: '50', // won't sign any tx over $50

    // Swap to Solana setup instead:
    // AGENTWALLET_CHAIN: 'solana',
    // AGENTWALLET_SOLANA_NETWORK: 'mainnet-beta',
  },
});
```

Now your agent can respond to:

- *"What's my wallet balance?"* → checks all token balances
- *"Send 10 USDC to 0x..."* → signs and submits the transfer
- *"Swap 0.5 SOL to USDC"* → Jupiter route, best price
- *"Bridge 100 USDC from base to arbitrum"* → CCTP V2, ~3 min
- *"Pay x402 endpoint https://api.example.com max 0.001 USDC"* → micropayment, instant

## Available actions

| Action | Trigger examples | Chains |
|--------|-----------------|--------|
| `WALLET_BALANCE` | "check balance", "how much do I have" | EVM + Solana |
| `WALLET_TRANSFER` | "send 10 USDC to 0x...", "pay 0.1 SOL to..." | EVM + Solana |
| `WALLET_SWAP` | "swap 0.5 ETH to USDC", "swap 1 SOL for USDT" | EVM (Uniswap V3) + Solana (Jupiter) |
| `WALLET_BRIDGE` | "bridge 100 USDC from base to solana" | 17 chains via CCTP V2 |
| `X402_PAY` | "pay x402 endpoint https://..." | Solana (sub-cent) + EVM |

## Wallet provider

The plugin automatically injects wallet state into the agent's context before each response:

```
## Agent Wallet
Address: 0xYourAgentAddress
Chain: evm (base)
Balances:
  ETH: 0.5 ($1,200.00)
  USDC: 250.00 ($250.00)
Spend limit: $50 per transaction
```

This lets the agent reason about its own funds before deciding to spend. It won't try to send $500 when it only has $250.

## Settings reference

| Setting | Required | Default | Description |
|---------|----------|---------|-------------|
| `AGENTWALLET_PRIVATE_KEY` | ✅ | — | Private key. Hex for EVM, base58 for Solana |
| `AGENTWALLET_CHAIN` | ✅ | — | `evm` or `solana` |
| `AGENTWALLET_EVM_NETWORK` | — | `base` | `base`, `arbitrum`, `optimism`, `ethereum` |
| `AGENTWALLET_SOLANA_NETWORK` | — | `mainnet-beta` | `mainnet-beta` or `devnet` |
| `AGENTWALLET_SPEND_LIMIT_USD` | — | `50` | Max USD per transaction |
| `AGENTWALLET_RPC_URL` | — | public | Custom RPC endpoint (use your own for production) |

## How it compares to plugin-evm

ElizaOS's built-in `plugin-evm` is great for getting started but has some gaps:

- No x402 micropayment support
- No spend limits (agent can drain itself)
- No CCTP cross-chain bridge
- No Jupiter swaps on Solana
- Routes through LiFi (adds a dependency)

This plugin is a drop-in addition for teams that need the full financial stack.

## Security

- The private key never leaves your infrastructure. It's passed as a runtime setting and used locally to sign transactions.
- Spend limits are enforced before every transaction. Set them low.
- For production deployments, use a dedicated agent keypair with a small funded balance — don't point this at your main treasury.

## License

MIT — [agentwallet-sdk](https://github.com/agentwallet-sdk/agentwallet-sdk) | [ai-agent-economy.com](https://ai-agent-economy.com)
