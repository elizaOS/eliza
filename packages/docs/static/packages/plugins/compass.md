# @elizaos-plugins/plugin-compass

## Purpose

A plugin that integrates the Compass API into the ElizaOS ecosystem to execute operations on DeFi protocols.

## Key Features

- Leverages the `@compass-labs/sdk` TypeScript SDK
- Provides actions corresponding to Compass API endpoints and schemas

## Installation

```
npx elizaos plugins add @elizaos-plugins/plugin-compass
bun run build
```

## Configuration

Required environment variables:

- COMPASS_WALLET_PRIVATE_KEY
- COMPASS_ARBITRUM_RPC_URL
- COMPASS_ETHEREUM_RPC_URL
- COMPASS_BASE_RPC_URL

These can also be set directly in the character configuration under settings.secrets.

## Integration

Added to the character configuration in the "plugins" array as "@elizaos-plugins/plugin-compass".

## Links

- [Compass API](https://api.compasslabs.ai/)
- [Compass SDK](https://www.npmjs.com/package/@compass-labs/sdk)
