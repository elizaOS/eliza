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

## Actions

Farcaster public posts are exposed through the primary `POST` action:

- `POST operation=send` publishes a cast through the Farcaster PostConnector.
- `POST operation=read` reads recent casts through the Farcaster PostConnector.

Farcaster search is not advertised until the local Neynar client exposes a
search primitive.

## Providers

### farcaster_profile

Provides the agent's Farcaster profile information for context.

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
