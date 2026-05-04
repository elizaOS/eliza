# @elizaos/plugin-farcaster

A multi-language Farcaster plugin for elizaOS, providing full integration with the Farcaster decentralized social network via the Neynar API.

## Languages

This plugin is implemented in three languages with full feature parity:

- **TypeScript** - Primary implementation for Node.js and browser
- **Python** - Python implementation for ML/AI pipelines
- **Rust** - High-performance implementation with WASM support

## Features

- **Cast Management**: Send casts, reply to casts, and manage your timeline
- **Profile Management**: Fetch and cache user profiles
- **Mentions & Notifications**: Monitor and respond to mentions
- **Timeline Provider**: Access your Farcaster feed
- **Thread Support**: Navigate and respond within cast threads
- **Embed Processing**: Handle images, videos, and embedded casts
- **Webhook Support**: Real-time updates via webhooks
- **Polling Mode**: Periodic fetching for simple deployments

## Installation

### TypeScript/Node.js

```bash
npm install @elizaos/plugin-farcaster
# or
bun add @elizaos/plugin-farcaster
```
## Configuration

The plugin requires the following environment variables:

| Variable                   | Required | Description                                               |
| -------------------------- | -------- | --------------------------------------------------------- |
| `FARCASTER_FID`            | Yes      | Your Farcaster ID (FID)                                   |
| `FARCASTER_SIGNER_UUID`    | Yes      | Neynar signer UUID for signing casts                      |
| `FARCASTER_NEYNAR_API_KEY` | Yes      | Neynar API key for API access                             |
| `FARCASTER_DRY_RUN`        | No       | Enable dry run mode (default: false)                      |
| `FARCASTER_MODE`           | No       | Operation mode: 'polling' or 'webhook' (default: polling) |
| `MAX_CAST_LENGTH`          | No       | Maximum cast length (default: 320)                        |
| `FARCASTER_POLL_INTERVAL`  | No       | Polling interval in seconds (default: 120)                |
| `ENABLE_CAST`              | No       | Enable auto-casting (default: true)                       |
| `CAST_INTERVAL_MIN`        | No       | Min cast interval in minutes (default: 90)                |
| `CAST_INTERVAL_MAX`        | No       | Max cast interval in minutes (default: 180)               |

## Usage

### TypeScript

```typescript
import farcasterPlugin from "@elizaos/plugin-farcaster";

// Register with agent runtime
const agent = new AgentRuntime({
  plugins: [farcasterPlugin],
  // ... other config
});
```
# Load configuration from environment
config = FarcasterConfig.from_env()

# Create client
async with FarcasterClient(config) as client:
    # Send a cast
    casts = await client.send_cast("Hello from elizaOS! 🤖")
    print(f"Cast sent: {casts[0].hash}")
```
## Actions

### SEND_CAST

Posts a new cast to Farcaster.

```typescript
// Triggered by messages containing: post, cast, share, announce, farcaster, post
"Please post about the new ElizaOS features on Farcaster";
```

### REPLY_TO_CAST

Replies to an existing cast.

```typescript
// Triggered by messages containing: reply, respond, answer, comment
"Reply to that cast and thank them for the feedback";
```

## Providers

### farcaster_profile

Provides the agent's Farcaster profile information for context.

### farcaster_timeline

Provides the agent's recent timeline for context about recent activity.

### farcaster_thread

Provides thread context for understanding conversation flow.

## Development

### Building

```bash
# TypeScript
bun run build
# All languages
bun run test

# TypeScript only
bun run test:ts

# Python only
bun run test:python

# Rust only
bun run test:rust
```

### Linting

```bash
# TypeScript
bun run lint