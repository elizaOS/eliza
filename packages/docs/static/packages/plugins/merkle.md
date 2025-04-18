# MerkleTrade Plugin for Eliza

## Purpose

This plugin enables interaction with MerkleTrade within the elizaOS ecosystem.

## Configuration

The plugin requires the following environment variables:

Merkle Configuration

```env
MERKLE_TRADE_NETWORK=               # Must be one of mainnet, testnet
MERKLE_TRADE_APTOS_PRIVATE_KEY=     # Aptos private key
```

## Installation

```json
{
  "plugins": ["@elizaos/plugin-merkle"]
}
```

## Integration

The plugin responds to natural language commands related to MerkleTrade operations.

## Example Usage

```bash
You: "Open a BTC Long position on the Merkle Trade platform with 1000 pay and 10 leverage."
Agent: "Successfully market order BTC with 1000 pay and 10 leverage, Transaction: 0x104af5d1a786a2e1a4721a721b2cfccc7e15fa41eec15a489ba1768790adb523"
```

## Links

- [Merkle Documentation](https://docs.merkle.trade/)
- [Aptos Documentation](https://aptos.dev/)
- [Move Language Guide](https://move-language.github.io/move/)
