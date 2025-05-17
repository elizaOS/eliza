# Blockend Plugin for Eliza OS

## Overview

`plugin-blockend` is a plugin for [Eliza OS](https://github.com/elizaos/eliza) that enables seamless execution of on-chain transactions, including swaps, bridges, and transfers, across multiple blockchains. It abstracts the complexity of interacting with different chains and assets, providing a unified interface for transaction execution.

## Features

-   Swap tokens on supported blockchains (e.g., Solana, Ethereum)
-   Bridge assets between chains
-   Unified transaction execution interface
-   Extensible and type-safe
-   Built-in validation and error handling

## Installation

```bash
# From the root of your Eliza OS monorepo
pnpm add @elizaos/plugin-blockend
```

Or, if using npm:

```bash
npm install @elizaos/plugin-blockend
```

Or, if using yarn:

```bash
yarn add @elizaos/plugin-blockend
```

## Configuration

The plugin requires several environment variables to be set for secure and correct operation:

| Variable                 | Description                            | Required |
| ------------------------ | -------------------------------------- | -------- |
| `WALLET_KEYPAIR`         | Solana wallet keypair (base58-encoded) | Yes      |
| `WALLET_PRIVATE_KEY`     | EVM wallet private key                 | Yes      |
| `BLOCKEND_INTEGRATOR_ID` | Blockend API integrator ID             | Yes      |
| `SOLANA_RPC_URL`         | Solana RPC endpoint URL                | Yes      |

You can set these in your environment variables or via Eliza OS settings.

## Usage

Once installed and configured, the plugin exposes the `blockend` action to Eliza OS agents. The main action is `GET_TXN_EXECUTION`, which handles swaps, bridges, and transfers.

### Example: Swap SOL for USDC on Solana

```json
{
    "fromAssetSymbol": "SOL",
    "toAssetSymbol": "USDC",
    "fromChainName": "solana",
    "toChainName": "solana",
    "amount": 0.1,
    "slippage": 50
}
```

### Example: Bridge SOL from Solana to ETH on Ethereum

```json
{
    "fromAssetSymbol": "SOL",
    "toAssetSymbol": "ETH",
    "fromChainName": "solana",
    "toChainName": "ethereum",
    "amount": 1,
    "slippage": 50
}
```

## API/Actions

### `GET_TXN_EXECUTION`

-   **Description:** Executes a transaction (swap, bridge, or transfer) based on user input.
-   **Parameters:**

    -   `fromAssetSymbol` (string): Token being sold
    -   `toAssetSymbol` (string): Token being bought
    -   `fromChainName` (string): Source chain
    -   `toChainName` (string): Destination chain
    -   `amount` (number|string): Amount to swap/bridge/transfer
    -   `slippage` (number|string, optional): Allowed slippage (default: 50 bps)

-   **Returns:** Transaction execution result or error message.

## Example Workflows

See [`src/examples.ts`](./src/examples.ts) for more sample conversations and agent responses.

## Types

The plugin uses a rich set of types for assets, chains, transactions, and routes. See [`src/types.ts`](./src/types.ts) for details.

## Development

To build and develop locally:

```bash
pnpm build
# or
npm run build
```

To run in watch mode:

```bash
pnpm dev
# or
npm run dev
```

## License

This plugin is part of the Eliza project.
