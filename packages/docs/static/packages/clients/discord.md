# @elizaos/client-discord

## Purpose

A Discord client implementation for ElizaOS, enabling rich integration with Discord servers for managing interactions, voice, and message handling.

## Key Features

- Handle server join events and manage initial configurations
- Voice event management via the voice manager
- Manage and process new messages with the message manager
- Slash command registration and interaction handling
- Disconnect websocket and unbind all listeners when required
- Robust permissions management for bot functionality

## Installation

As this is a workspace package, it's installed as part of the ElizaOS monorepo:

```bash
bun install
```

## Configuration

The client requires the following environment variables:

```bash
# Discord API Credentials
DISCORD_APPLICATION_ID=your_application_id
DISCORD_API_TOKEN=your_api_token

# Optional Settings
```

## Example Usage

### Basic Initialization

```typescript
import { DiscordClientInterface } from '@elizaos/client-discord';

// Initialize the client
const discordManager = await DiscordClientInterface.start(runtime);
```

### Slash Command Registration

```typescript
await discordManager.command.registerCommands([
  {
    name: 'example',
    description: 'An example slash command',
    options: [],
  },
]);
```
