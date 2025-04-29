# @elizaos/plugin-edwin

## Purpose

Edwin plugin for Eliza that enables interaction with Edwin tools for DeFi operations.

## Installation

```bash
bun install
```

## Configuration

Configure environment variables for chains you want to support:

```env
EVM_PRIVATE_KEY=<YOUR_EVM_PRIVATE_KEY>
SOLANA_PRIVATE_KEY=<YOUR_SOLANA_PRIVATE_KEY>
```

## Integration

The plugin provides access to the following Edwin tools:

- supply
- withdraw
- stake
- addLiquidity
- removeLiquidity

## Example Usage

1. Supply on AAVE:

```
Supply 100 USDC to AAVE
```

2. Add liquidity on Meteora:

```
Find a meteora pool with high liquidity and add to td 10 USDC and 0.01 SOL.
```

## Links

[Edwin docs](https://docs.edwin.finance)
