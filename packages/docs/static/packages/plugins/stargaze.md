# Plugin Stargaze

## Purpose

A plugin for fetching NFT data from the Stargaze API.

## Key Features

Provides a simple interface to get NFT data from Stargaze collections.

## Installation

```bash
bun add @elizaos/plugin-stargaze
```

## Configuration

Set up your environment with the required Stargaze API endpoint.

| Variable Name       | Description                   |
| ------------------- | ----------------------------- |
| `STARGAZE_ENDPOINT` | Stargaze GraphQL API endpoint |

## Integration

Integrates with Stargaze's GraphQL API to fetch the latest NFTs from collections.

## Example Usage

```typescript
import { stargazePlugin } from '@elizaos/plugin-stargaze';

// Initialize the plugin
const plugin = stargazePlugin;

// The plugin provides the GET_LATEST_NFT action which can be used to fetch NFTs
// Example: "Show me the latest NFT from ammelia collection"
```

## Links

License: MIT
