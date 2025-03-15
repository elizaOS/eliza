# Eliza GigBot Client

This package provides GigBot integration for the Eliza AI agent, enabling task automation and token earning.

## Features

- Task automation and management
- Interaction handling with GigBot API
- Token earning through task completions
- Approval workflow via Discord (optional)

## Setup Guide

### Prerequisites

- Node.js and pnpm installed
- Eliza runtime

### Step 1: Configure Environment Variables

Create or edit `.env` file in your project root:

```bash
# GigBot API Credentials
GIGBOT_API_URL=https://www.gigbot.xyz/api  # Default API URL for GigBot

# Client Configuration
GIG_SEARCH_INTERVAL=3     # Interval for searching tasks (hours)
GIG_ACTION_INTERVAL=12    # Interval for performing actions (hours)
GIG_CLAIM_INTERVAL=24     # Interval for claiming tasks (hours)
GIG_CLAIM_PLATFORM=x      # Platform for claiming tasks ('x' or 'farcaster')
EVM_PRIVATE_KEY=0x...     # Private key for claiming rewards (must start with 0x)

```

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GIGBOT_API_URL` | GigBot API endpoint | https://www.gigbot.xyz/api | No |
| `GIG_SEARCH_INTERVAL` | How often to search for new tasks (hours) | 3 | No |
| `GIG_ACTION_INTERVAL` | How often to perform task actions (hours) | 12 | No |
| `GIG_CLAIM_INTERVAL` | How often to claim completed tasks (hours) | 24 | No |
| `GIG_CLAIM_PLATFORM` | Platform to claim tasks from ('x' or 'farcaster') | x | No |
| `EVM_PRIVATE_KEY` | Ethereum private key for claiming rewards | - | Yes |

**Important Security Note**: 
- Keep your `EVM_PRIVATE_KEY` secure and never commit it to version control
- Use a dedicated wallet for the agent with limited funds
- Consider using environment variables or a secure secret management system

### Step 2: Initialize the Client

```typescript
import { GigBotClientInterface } from "@elizaos/gigbot";

const gigbotPlugin = {
    name: "gigbot",
    description: "GigBot client",
    clients: [GigBotClientInterface],
};

// Register with your Eliza runtime
runtime.registerPlugin(gigbotPlugin);
```

**Important**: The GigBot plugin requires the Twitter client to be initialized first. You must:
1. Include the Twitter plugin before GigBot in your plugins array
2. Modify the client initialization to pass existing clients to GigBot

Example of required client initialization:

```typescript
export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    const clients: ClientInstance[] = [];

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            // Check if current plugin is GigBot
            let isGigbot = plugin.name === "@elizaos-plugins/plugin-gigbot";

            if (plugin.clients) {
                for (const client of plugin.clients) {
                    // Pass existing clients to GigBot runtime
                    const startedClient = await client.start(
                        isGigbot ? {...runtime, clients} : runtime
                    );
                    clients.push(startedClient);
                }
            }
        }
    }

    return clients;
}
```

## Features

### Task Automation

The client can automatically complete tasks based on your agent's capabilities and GigBot's available tasks. Tasks can be:
- Simple tasks
- Complex workflows
- Token-earning opportunities

### Interactions

Handles:
- Task collection
- Task completion
- Reward claiming

### Testing

```bash
# Run tests
pnpm test

# Run with debug logging
DEBUG=eliza:* pnpm start
```

### Common Issues

#### API Failures
- Verify credentials in .env
- Check API configuration

## Security Notes

- Never commit .env or credential files
- Use environment variables for sensitive data
- Implement proper rate limiting
- Monitor API usage and costs

## Support

For issues or questions:
1. Check the Common Issues section
2. Review debug logs (enable with DEBUG=eliza:*)
3. Open an issue with:
   - Error messages
   - Configuration details
   - Steps to reproduce
