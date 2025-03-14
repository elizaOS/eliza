# MerkleTrade Plugin for Eliza

This plugin is a sample plugin for interacting with MerkleTrade within the elizaOS ecosystem.

## Configuration

The plugin requires the following environment variables to be set:

Merkle Configuration

```env
MERKLE_TRADE_NETWORK=               # Must be one of mainnet, testnet
MERKLE_TRADE_APTOS_PRIVATE_KEY=     # Aptos private key
```

### Installation

```json
{
  "plugins": ["@elizaos/plugin-merkle"]
}
```

## Usage

### Example

```bash
// The plugin responds to natural language like:

You: "Open a BTC Long position on the Merkle Trade platform with 1000 pay and 10 leverage."
Agent: "Successfully market order BTC with 1000 pay and 10 leverage, Transaction: 0x104af5d1a786a2e1a4721a721b2cfccc7e15fa41eec15a489ba1768790adb523"
```

## Actions

- OPEN_ORDER
- GET_PRICE
- GET_POSITION
- GET_ORDER
- GET_BALANCE
- FULLY_CLOSE_POSITION

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm build
```

## Dependencies

- @elizaos/core: v0.1.9
- @merkletrade/ts-sdk: ^v1.0.0
- @aptos-labs/ts-sdk: ^v1.26.0
- node-cache: 5.1.2

For more information:

- [Merkle Documentation](https://docs.merkle.trade/)
- [Aptos Documentation](https://aptos.dev/)
- [Move Language Guide](https://move-language.github.io/move/)
