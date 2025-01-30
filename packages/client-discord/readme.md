# @elizaos/client-discord

A Discord client implementation for ElizaOS, enabling rich integration with Discord servers for managing interactions, voice, and message handling.

## Features

- Handle server join events and manage initial configurations.
- Voice event management via the voice manager.
- Manage and process new messages with the message manager.
- Slash command registration and interaction handling.
- Disconnect websocket and unbind all listeners when required.
- Robust permissions management for bot functionality.

## Installation

As this is a workspace package, it's installed as part of the ElizaOS monorepo:

```bash
pnpm install
```

## Configuration

The client requires the following environment variables:

```bash
# Discord API Credentials
DISCORD_APPLICATION_ID=your_application_id
DISCORD_API_TOKEN=your_api_token

# Optional Settings (add any additional details here if necessary)
```

## Usage

### Basic Initialization

```typescript
import { DiscordClientInterface } from '@elizaos/client-discord';

// Initialize the client
const discordManager = await DiscordClientInterface.start(runtime);
```

### Slash Command Registration

To register slash commands:

```typescript
await discordManager.command.registerCommands([
  {
    name: 'example',
    description: 'An example slash command',
    options: []
  }
]);
```

### Handling Messages

```typescript
// Listen for new messages
await discordManager.message.handleNewMessage({
  channelId: 'channel-id',
  content: 'Hello Discord!'
});
```

### Managing Voice Events

```typescript
// Join a voice channel
await discordManager.voice.joinChannel('channel-id');

// Handle voice interactions
await discordManager.voice.handleInteraction({
  userId: 'user-id',
  action: 'speak'
});
```

## Key Components

1. **ClientBase**
    - Handles authentication and session management.
    - Manages websocket connections.

2. **MessageManager**
    - Processes incoming messages and responses.
    - Supports message formatting and templating.

3. **VoiceManager**
    - Manages voice interactions and events.
    - Handles joining and leaving voice channels.

4. **CommandManager**
    - Registers and processes slash commands.
    - Ensures permissions are validated.

## Notes

Ensure that your `.env` file includes the required environment variables for proper functionality. Additional features or modules can be extended as part of the ElizaOS framework.
