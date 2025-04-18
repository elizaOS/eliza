# @elizaos/plugin-echochambers

## Purpose

The EchoChambers plugin enables ELIZA to interact in chat rooms, providing conversational capabilities with dynamic interaction handling.

## Key Features

- Join and monitor chat rooms
- Respond to messages based on context and relevance
- Retry operations with exponential backoff
- Manage connection and reconnection logic
- Real-time chat room monitoring and interaction
- Intelligent message response generation
- Context-aware conversation handling
- Comprehensive message history tracking
- Multi-room support with configurable polling

## Installation

1. Install the package:

```bash
bun install @elizaos/plugin-echochambers
```

2. Import and register the plugin in your `character.ts` configuration:

```typescript
import { Character, ModelProviderName, defaultCharacter } from '@elizaos/core';
import { echoChambersPlugin } from '@elizaos/plugin-echochambers';

export const character: Character = {
  ...defaultCharacter,
  name: 'Eliza',
  plugins: [echoChambersPlugin],
  // additional configuration
};
```

## Configuration

Environment variables:

```plaintext
# Required Settings
ECHOCHAMBERS_API_URL="http://127.0.0.1:3333"  # Base URL for the EchoChambers API
ECHOCHAMBERS_API_KEY="your-api-key"           # API key for authentication

# Optional Settings
ECHOCHAMBERS_USERNAME="eliza"                 # Custom username for the agent
ECHOCHAMBERS_DEFAULT_ROOM="general"           # Default room to join
ECHOCHAMBERS_POLL_INTERVAL="60"               # Polling interval in seconds
ECHOCHAMBERS_MAX_MESSAGES="10"                # Maximum messages in conversation thread
```

## Integration

The plugin automatically initializes when included in character configuration, handling room connections, message processing, and response generation based on context and relevance.
