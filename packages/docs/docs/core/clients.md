---
sidebar_position: 3
---

# 🔌 Clients

Clients are core components in Eliza that enable AI agents to interact with external platforms and services. Each client provides a specialized interface for communication while maintaining consistent agent behavior across different platforms.

---

## Supported Clients

| Client | Type | Key Features | Use Cases |
|--------|------|--------------|------------|
| [Discord](https://github.com/elizaos-plugins/client-discord) | Communication | • Voice channels • Server management • Moderation tools • Channel management | • Community management • Gaming servers • Event coordination |
| [Twitter](https://github.com/elizaos-plugins/client-twitter) | Social Media | • Post scheduling • Timeline monitoring • Engagement analytics • Content automation | • Brand management • Content creation • Social engagement |
| [Telegram](https://github.com/elizaos-plugins/client-telegram) | Messaging | • Bot API • Group chat • Media handling • Command system | • Customer support • Community engagement • Broadcast messaging |
| [Direct](https://github.com/elizaOS/eliza/tree/develop/packages/client-direct/src) | API | • REST endpoints • Web integration • Custom applications • Real-time communication | • Backend integration • Web apps • Custom interfaces |
| [GitHub](https://github.com/elizaos-plugins/client-github) | Development | • Repository management • Issue tracking • Pull requests • Code review | • Development workflow • Project management • Team collaboration |
| [Slack](https://github.com/elizaos-plugins/client-slack) | Enterprise | • Channel management • Conversation analysis • Workspace tools • Integration hooks | • Team collaboration • Process automation • Internal tools |
| [Lens](https://github.com/elizaos-plugins/client-lens) | Web3 | • Decentralized networking • Content publishing • Memory management • Web3 integration | • Web3 social networking • Content distribution • Decentralized apps |
| [Farcaster](https://github.com/elizaos-plugins/client-farcaster) | Web3 | • Decentralized social • Content publishing • Community engagement | • Web3 communities • Content creation • Social networking |
| [Auto](https://github.com/elizaos-plugins/client-auto) | Automation | • Workload management • Task scheduling • Process automation | • Background jobs • Automated tasks • System maintenance |

***Additional clients**:
- Instagram: Social media content and engagement
- XMTP: Web3 messaging and communications
- Alexa: Voice interface and smart device control
- Home Assistant: Home automation OS 
- Devai.me: AI first social client
- Simsai: Jeeter / Social media platform for AI

---

## System Overview

Clients serve as bridges between Eliza agents and various platforms, providing core capabilities:

1. **Message Processing**
   - Platform-specific message formatting and delivery
   - Media handling and attachments via [`Memory`](/api/interfaces/Memory) objects
   - Reply threading and context management
   - Support for different content types

2. **State & Memory Management**
   - Each client maintains independent state to prevent cross-platform contamination
   - Integrates with runtime memory managers for different types of content:
   - Messages processed by one client don't automatically appear in other clients' contexts
   - [`State`](/api/interfaces/State) persists across agent restarts through the database adapter

3. **Platform Integration** 
   - Authentication and API compliance
   - Event processing and webhooks
   - Rate limiting and cache management
   - Platform-specific feature support



## Client Configuration

Clients are configured through the [`Character`](/api/type-aliases/Character) configuration's [`clientConfig`](/api/type-aliases/Character/#clientconfig) property:

```typescript
export type Character = {
    // ... other properties ...
    clientConfig?: {
        discord?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
            shouldRespondOnlyToMentions?: boolean;
            messageSimilarityThreshold?: number;
            isPartOfTeam?: boolean;
            teamAgentIds?: string[];
            teamLeaderId?: string;
            teamMemberInterestKeywords?: string[];
            allowedChannelIds?: string[];
            autoPost?: {
                enabled?: boolean;
                monitorTime?: number;
                inactivityThreshold?: number;
                mainChannelId?: string;
                announcementChannelIds?: string[];
                minTimeBetweenPosts?: number;
            };
        };
        telegram?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
            shouldRespondOnlyToMentions?: boolean;
            shouldOnlyJoinInAllowedGroups?: boolean;
            allowedGroupIds?: string[];
            messageSimilarityThreshold?: number;
            // ... other telegram-specific settings
        };
        slack?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
        };
        // ... other client configs
    };
};
```

## Client Implementation

Each client manages its own:
- Platform-specific message formatting and delivery
- Event processing and webhooks
- Authentication and API integration
- Message queueing and rate limiting
- Media handling and attachments
- State management and persistence

Example of a basic client implementation:

```typescript
import { Client, IAgentRuntime, ClientInstance } from "@elizaos/core";

export class CustomClient implements Client {
    name = "custom";
    
    async start(runtime: IAgentRuntime): Promise<ClientInstance> {
        // Initialize platform connection
        // Set up event handlers
        // Configure message processing

        return {
            stop: async () => {
                // Cleanup resources
                // Close connections
            }
        };
    }
}
```

### Runtime Integration

Clients interact with the agent runtime through the [`IAgentRuntime`](api/interfaces/IAgentRuntime/) interface, which provides:

- Memory managers for different types of data storage
- Service access for capabilities like transcription or image generation
- State management and composition
- Message processing and action handling


### Memory System Integration

Clients use the runtime's memory managers to persist conversation data (source: [`memory.ts`](/api/interfaces/Memory)).

- `messageManager` Chat messages
- `documentsManager` File attachments  
- `descriptionManager` Media descriptions

<details>
<summary>See example</summary>
```typescript
// Store a new message
await runtime.messageManager.createMemory({
    id: messageId,
    content: { text: message.content },
    userId: userId,
    roomId: roomId,
    agentId: runtime.agentId
});

// Retrieve recent messages
const recentMessages = await runtime.messageManager.getMemories({
    roomId: roomId,
    count: 10
});
```
</details>

---

## Direct Client Example

The [Direct client](https://github.com/elizaOS/eliza/tree/develop/packages/client-direct) provides message processing, webhook integration, and a REST API interface for Eliza agents. It's the primary client used for testing and development.


Key features of the Direct client:
- Express.js server for HTTP endpoints
- Agent runtime management
- File upload handling
- Memory system integration
- WebSocket support for real-time communication


### Direct Client API Endpoints

| Endpoint                                | Method | Description                                     | Params                       | Input                                  | Response                                |
|-----------------------------------------|--------|-------------------------------------------------|------------------------------|-----------------------------------------|------------------------------------------|
| `/:agentId/whisper`                     | POST   | Audio transcription (Whisper)                   | `agentId`                     | Audio file                              | Transcription                            |
| `/:agentId/message`                     | POST   | Main message handler                            | `agentId`                     | Text, optional file                     | Agent response                           |
| `/agents/:agentIdOrName/hyperfi/v1`     | POST   | Hyperfi game integration                        | `agentIdOrName`               | Objects, emotes, history                | JSON (`lookAt`, `emote`, `say`, actions) |
| `/:agentId/image`                       | POST   | Image generation                               | `agentId`                     | Generation params                        | Image(s) with captions                   |
| `/fine-tune`                            | POST   | Proxy for BagelDB fine-tuning                  | None                          | Fine-tuning data                         | BagelDB API response                     |
| `/fine-tune/:assetId`                   | GET    | Download fine-tuned assets                     | `assetId`                     | None                                    | File download                            |
| `/:agentId/speak`                       | POST   | Text-to-speech (ElevenLabs)                    | `agentId`                     | Text                                    | Audio stream                             |
| `/:agentId/tts`                         | POST   | Direct text-to-speech                          | `agentId`                     | Text                                    | Audio stream                             |

### Static Routes
| Endpoint                | Method | Description              |
|-------------------------|--------|--------------------------|
| `/media/uploads/`      | GET    | Serves uploaded files    |
| `/media/generated/`    | GET    | Serves generated images  |

### Common Parameters
Most endpoints accept:
- `roomId` (defaults to agent-specific room)
- `userId` (defaults to `"user"`)
- `userName` (for identity management)

---

## FAQ

### What can clients actually do?

Clients handle platform-specific communication (like Discord messages or Twitter posts), manage memories and state, and execute actions like processing media or handling commands. Each client adapts these capabilities to its platform while maintaining consistent agent behavior.

### Can multiple clients be used simultaneously?
Yes, Eliza supports running multiple clients concurrently while maintaining consistent agent behavior across platforms.

### How are client-specific features handled?
Each client implements platform-specific features through its capabilities system, while maintaining a consistent interface for the agent.

### How co clients handle rate limits?
Clients implement platform-specific rate limiting with backoff strategies and queue management.

### How is client state managed?
Clients maintain their own connection state while integrating with the agent's runtime database adapter and memory / state management system.

### How do clients handle messages?

Clients translate platform messages into Eliza's internal format, process any attachments (images, audio, etc.), maintain conversation context, and manage response queuing and rate limits.

### How are messages processed across clients?
Each client processes messages independently in its platform-specific format, while maintaining conversation context through the shared memory system. V2 improves upon this architecture.

### How is state managed between clients?
Each client maintains separate state to prevent cross-contamination, but can access shared agent state through the runtime.


### How do clients integrate with platforms?

Each client implements platform-specific authentication, API compliance, webhook handling, and follows the platform's rules for rate limiting and content formatting.

### How do clients manage memory?

Clients use Eliza's memory system to track conversations, user relationships, and state, enabling context-aware responses and persistent interactions across sessions.
