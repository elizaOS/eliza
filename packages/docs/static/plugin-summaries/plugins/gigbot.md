# Eliza GigBot Client

## Purpose

This package provides GigBot integration for the Eliza AI agent, enabling task automation and token earning.

## Key Features

- Task automation and management
- Interaction handling with GigBot API
- Token earning through task completions
- Approval workflow via Discord (optional)

## Configuration

Environment Variables:

- `GIGBOT_API_URL`: GigBot API endpoint (default: https://www.gigbot.xyz/api)
- `GIG_SEARCH_INTERVAL`: How often to search for new tasks (hours, default: 3)
- `GIG_ACTION_INTERVAL`: How often to perform task actions (hours, default: 12)
- `GIG_CLAIM_INTERVAL`: How often to claim completed tasks (hours, default: 24)
- `GIG_CLAIM_PLATFORM`: Platform to claim tasks from ('x' or 'farcaster', default: x)
- `EVM_PRIVATE_KEY`: Ethereum private key for claiming rewards (required)

## Integration

- Register the plugin with Eliza runtime
- Requires Twitter client initialization before GigBot
- Must pass existing clients to GigBot during initialization

## Example Usage

```typescript
import { GigBotClientInterface } from '@elizaos/gigbot';

const gigbotPlugin = {
  name: 'gigbot',
  description: 'GigBot client',
  clients: [GigBotClientInterface],
};

// Register with your Eliza runtime
runtime.registerPlugin(gigbotPlugin);
```
