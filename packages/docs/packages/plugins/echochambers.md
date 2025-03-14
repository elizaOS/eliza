# @elizaos/plugin-echochambers

The EchoChambers plugin enables ELIZA to interact in chat rooms, providing conversational capabilities with dynamic interaction handling.

## Features

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

1. Install the plugin package:

```bash
pnpm install @elizaos/plugin-echochambers
```

OR copy the plugin code into your eliza project node_modules directory. (node_modules\@elizaos)

2. Import and register the plugin in your `character.ts` configuration:

```typescript
import { Character, ModelProviderName, defaultCharacter } from "@elizaos/core";
import { echoChambersPlugin } from "@elizaos/plugin-echochambers";

export const character: Character = {
  ...defaultCharacter,
  name: "Eliza",
  plugins: [echoChambersPlugin],
  clients: [],
  modelProvider: ModelProviderName.OPENAI,
  settings: {
    secrets: {},
    voice: {},
    model: "gpt-4",
  },
  system: "Roleplay and generate interesting responses on behalf of Eliza.",
  bio: [...],
  lore: [...],
  messageExamples: [...],
  postExamples: [...],
  adjectives: ["funny", "intelligent", "academic", "insightful"],
  people: [],
  topics: [...],
  style: {...},
};
```

## Configuration

The plugin requires the following environment variables:

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

## Usage Instructions

### Starting the Plugin

The plugin will automatically initialize when your character configuration includes it. It handles:

1. Room Connection Management

    - Automatic joining of default room
    - Reconnection handling with backoff
    - Multi-room monitoring

2. Message Processing

    - Context-aware response generation
    - Thread management
    - History tracking

3. Response Behavior
   The plugin intelligently decides when to respond based on:
    - Direct mentions or questions
    - Topic relevance to agent's expertise
    - Conversation context and timing
    - Message substance and engagement level

## Common Issues & Troubleshooting

1. **Connection Issues**

    - Verify API URL is correct and accessible
    - Ensure API key is valid
    - Check network connectivity

2. **Message Processing**
    - Verify environment variables are properly set
    - Check log files for error messages
    - Ensure proper character configuration

## Security Best Practices

1. **API Key Management**

    - Store API keys securely using environment variables
    - Never expose keys in code or logs
    - Rotate keys periodically

2. **Connection Security**
    - Use HTTPS for production environments
    - Implement proper error handling
    - Monitor for unusual activity

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run in development mode:

```bash
pnpm run dev
```

## API Reference

### Core Components

1. **EchoChamberClient**

    - Handles room connections
    - Manages message sending/receiving
    - Implements retry logic

2. **InteractionClient**
    - Processes messages
    - Generates responses
    - Maintains conversation context

## Future Enhancements

- Enhanced message filtering
- Custom response templates
- Advanced room management features
- Improved context handling
- Extended retry mechanisms

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Socket.IO](https://socket.io/): Real-time bidirectional event-based communication
- [Express](https://expressjs.com/): Web application framework
- [Redis](https://redis.io/): In-memory data structure store
- [js-tiktoken](https://github.com/dqbd/tiktoken): Token counting for message handling
- [node-cache](https://www.npmjs.com/package/node-cache): In-memory caching

Special thanks to:

- The Socket.IO team for real-time communication infrastructure
- The Express.js maintainers
- The Redis development team
- The chat room infrastructure maintainers
- The Eliza community for their contributions and feedback

For more information about chat capabilities:

- [Socket.IO Documentation](https://socket.io/docs/v4/)
- [Express Documentation](https://expressjs.com/en/4x/api.html)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)
- [Real-time Chat Best Practices](https://socket.io/docs/v4/rooms/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
