---
title: "EVM Plugin"
sidebarTitle: "EVM"
description: "EVM chain connector for Eliza — Ethereum, Base, Arbitrum, Optimism, and other EVM-compatible chains."
---

The EVM plugin enables Eliza agents to interact with Ethereum and EVM-compatible chains — reading balances, sending tokens, interacting with smart contracts, executing swaps, and participating in DeFi protocols.

**Package:** `@elizaos/plugin-wallet`

## Overview

The EVM plugin provides the agent with an embedded wallet and a set of on-chain actions covering the most common DeFi operations across all major EVM chains.

## Installation

```bash
eliza plugins install @elizaos/plugin-wallet
```

## Auto-Enable

The plugin auto-enables when `ALCHEMY_API_KEY` is set (this is the `envKey` in `plugins.json`).

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `EVM_PRIVATE_KEY` | Yes | Private key for the agent's wallet (hex, starting with `0x`) |
| `EVM_RPC_PROVIDER` | No | Default RPC endpoint (mainnet) |
| `ALCHEMY_API_KEY` | No | Alchemy API key for multi-chain RPC (also the primary auto-enable trigger) |
| `INFURA_API_KEY` | No | Infura API key for RPC |
| `ANKR_API_KEY` | No | Ankr API key for RPC |
| `ETHEREUM_PROVIDER_ETHEREUM` | No | Custom RPC URL for Ethereum mainnet |
| `ETHEREUM_PROVIDER_BASE` | No | Custom RPC URL for Base |
| `ETHEREUM_PROVIDER_ARBITRUM` | No | Custom RPC URL for Arbitrum |
| `ETHEREUM_PROVIDER_OPTIMISM` | No | Custom RPC URL for Optimism |
| `TEE_MODE` | No | Trusted Execution Environment mode |
| `WALLET_SECRET_SALT` | No | Salt for wallet key derivation |
| `SEPOLIA_RPC_URL` | No | RPC URL for Sepolia testnet |
| `BASE_SEPOLIA_RPC_URL` | No | RPC URL for Base Sepolia testnet |

```json
{
  "settings": {
    "secrets": {
      "EVM_PRIVATE_KEY": "0x..."
    }
  }
}
```

## Supported Chains

| Chain | Chain ID | Native Token |
|-------|----------|-------------|
| Ethereum Mainnet | 1 | ETH |
| Base | 8453 | ETH |
| Arbitrum One | 42161 | ETH |
| Optimism | 10 | ETH |
| Polygon | 137 | MATIC |
| BSC | 56 | BNB |
| Avalanche C-Chain | 43114 | AVAX |
| Zora | 7777777 | ETH |
| Mode | 34443 | ETH |
| Blast | 81457 | ETH |

## Actions

| Action | Description |
|--------|-------------|
| `TRANSFER_TOKEN` | Send ETH or ERC-20 tokens to an address |
| `SWAP_TOKENS` | Swap tokens via DEX aggregators (1inch, Uniswap) |
| `GET_BALANCE` | Check ETH and token balances |
| `DEPLOY_CONTRACT` | Deploy a smart contract |
| `CALL_CONTRACT` | Read from a smart contract |
| `SEND_TRANSACTION` | Send a raw transaction |
| `SIGN_MESSAGE` | Sign an arbitrary message |
| `GET_TRANSACTION` | Look up a transaction by hash |
| `BRIDGE_TOKENS` | Bridge tokens cross-chain |

## Providers

| Provider | Description |
|----------|-------------|
| `walletBalance` | Current ETH and token balances |
| `walletAddress` | The agent's wallet address |
| `chainInfo` | Current chain ID and network |

## Usage Examples

After the plugin is loaded, the agent can execute on-chain operations through natural language:

> "Send 0.01 ETH to vitalik.eth"

> "Swap 100 USDC for ETH on Base"

> "What's my wallet balance on Arbitrum?"

> "Deploy the ERC-20 contract to Base Sepolia"

## Security Considerations

- The private key grants full control of the agent's wallet. Store it securely using the built-in [**@elizaos/core** secrets runtime](/runtime/services#secrets-secrets-service).
- Consider using a dedicated agent wallet with limited funds rather than a primary wallet.
- The plugin does not impose spending limits — any action the LLM selects will execute. Configure the character carefully.
- Use testnets (Base Sepolia, Arbitrum Sepolia) for development.

## Testnet Configuration

```json
{
  "settings": {
    "secrets": {
      "EVM_PRIVATE_KEY": "0x...",
      "EVM_RPC_PROVIDER": "https://sepolia.base.org"
    }
  }
}
```

## Related

- [Solana Plugin](/plugin-registry/defi/solana) — Solana chain integration
- [**@elizaos/core** secrets](/runtime/services#secrets-secrets-service) — Secure key storage
- [Wallet Guide](/guides/wallet) — Wallet setup and management
