# @elizaos/plugin-edwin

Edwin plugin for Eliza that enables interaction with Edwin tools for DeFi operations.

## About

See full info and docs at [Edwin docs](https://docs.edwin.finance).
## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables for chains you want to support:

```env
EVM_PRIVATE_KEY=<YOUR_EVM_PRIVATE_KEY>
SOLANA_PRIVATE_KEY=<YOUR_SOLANA_PRIVATE_KEY>
```

## Available Tools

The plugin provides access to the following Edwin tools:

-   supply
-   withdraw
-   stake
-   addLiquidity
-   removeLiquidity

## Usage Examples

1. Supply on AAVE:

```
Supply 100 USDC to AAVE
```

2. Add liquidity on Meteora:

```
Find a meteora pool with high liquidity and add to td 10 USDC and 0.01 SOL.
```

## Development

1. Build the plugin:

```bash
pnpm build
```

2. Run in development mode:

```bash
pnpm dev
```

## Dependencies

-   edwin-sdk

## License

MIT
