# Plugin Stargaze

A plugin for fetching NFT data from the Stargaze API.

## Overview

The Plugin Stargaze provides a simple interface to get NFT data from Stargaze collections. It integrates with Stargaze's GraphQL API to fetch the latest NFTs from collections.

## Installation

```bash
pnpm add @elizaos/plugin-stargaze
```

## Configuration

Set up your environment with the required Stargaze API endpoint, currently Stargaze offers https://graphql.mainnet.stargaze-apis.com/graphql publicly.

| Variable Name | Description |
| ------------- | ----------- |
| `STARGAZE_ENDPOINT` | Stargaze GraphQL API endpoint |

## Usage

```typescript
import { stargazePlugin } from "@elizaos/plugin-stargaze";

// Initialize the plugin
const plugin = stargazePlugin;

// The plugin provides the GET_LATEST_NFT action which can be used to fetch NFTs
// Example: "Show me the latest NFT from ammelia collection"
```

## License

MIT
