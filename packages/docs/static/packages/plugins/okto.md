# @okto_web3/eliza-plugin

## Purpose

A comprehensive integration plugin for ElizaOS that provides access to Okto's APIs and services, enabling seamless Web3 interactions.

## Key Features

- Portfolio Management (user portfolio data, NFT details, token holdings)
- Wallet Management (access wallets, view addresses)
- Token Operations (transfer tokens, swap tokens, execute transactions)
- NFT Operations (view collections, transfer NFTs, track balances)
- Chain Support (multiple networks including Ethereum, Polygon, Solana, etc.)
- Transaction History (view order history across networks)

## Installation

```bash
bun install @okto_web3/eliza-plugin
```

## Configuration

Requires environment variables:

- OKTO_ENVIRONMENT (defaults to "sandbox")
- OKTO_CLIENT_PRIVATE_KEY (required)
- OKTO_CLIENT_SWA (required)
- GOOGLE_CLIENT_ID (required)
- GOOGLE_CLIENT_SECRET (required)

## Integration

Import and initialize the plugin, then add it to AgentRuntime's plugins array and include oktoPlugin.oktoService in services.

## Example Usage

Available actions include OKTO_GET_PORTFOLIO, OKTO_GET_ACCOUNT, OKTO_TRANSFER, OKTO_SWAP, and others for managing tokens, NFTs, and viewing blockchain data.

## Links

[Okto Eliza Plugin Documentation](https://docsv2.okto.tech/docs/okto-eliza-plugin)
