# 🤖 Agent Runtime

The `AgentRuntime` is the core runtime environment for Eliza agents. It handles message processing, state management, plugin integration, and interaction with external services. You can think of it as the brains that provide the high-level orchestration layer for Eliza agents.

![](/img/eliza-architecture.jpg)

The runtime follows this general flow:
1. Agent loads character config, plugins, and services
	- Processes knowledge sources (e.g., documents, directories)
2. Receives a message, composes the state
3. Processes actions and then evaluates
	- Retrieves relevant knowledge fragments using RAG
4. Generates and executes responses, then evaluates
5. Updates memory and state


---

## Overview

The [AgentRuntime](/api/classes/AgentRuntime) class is the primary implementation of the [IAgentRuntime](/api/interfaces/IAgentRuntime) interface, which manages the agent's core functions, including:


| Component | Description | API Reference | Related Files |
|---------|-------------|---------------|---------------|
| **Clients** | Supports multiple communication platforms for seamless interaction. | [Clients API](/api/interfaces/IAgentRuntime/#clients) | [`clients.ts`](https://github.com/elizaos-plugins/client-discord/blob/main/__tests__/discord-client.test.ts), [`Discord`](https://github.com/elizaos-plugins/client-discord), [`Telegram`](https://github.com/elizaos-plugins/client-telegram), [`Twitter`](https://github.com/elizaos-plugins/client-twitter), [`Farcaster`](https://github.com/elizaos-plugins/client-farcaster), [`Lens`](https://github.com/elizaos-plugins/client-lens), [`Slack`](https://github.com/elizaos-plugins/client-slack), [`Auto`](https://github.com/elizaos-plugins/client-auto), [`GitHub`](https://github.com/elizaos-plugins/client-github) |
| **State** | Maintains context for coherent cross-platform interactions, updates dynamically. Also tracks goals, knowledge, and recent interactions | [State API](/api/interfaces/State) | [`state.ts`](https://github.com/elizaos/runtime/state.ts) |
| **Plugins** | Dynamic extensions of agent functionalities using custom actions, evaluators, providers, and adapters | [Plugins API](/api/type-aliases/Plugin/) | [`plugins.ts`](https://github.com/elizaos/runtime/plugins.ts), [actions](../actions), [evaluators](../evaluators), [providers](../providers) |
| **Services** | Connects with external services for `IMAGE_DESCRIPTION`, `TRANSCRIPTION`, `TEXT_GENERATION`, `SPEECH_GENERATION`, `VIDEO`, `PDF`, `BROWSER`, `WEB_SEARCH`, `EMAIL_AUTOMATION`, and more | [Services API](/api/interfaces/IAgentRuntime/#services) | [`services.ts`](https://github.com/elizaos/runtime/services.ts) |
| **Memory Systems** | Creates, retrieves, and embeds memories and manages conversation history. | [Memory API](/api/interfaces/IMemoryManager) | [`memory.ts`](https://github.com/elizaos/runtime/memory.ts) |
| **Database Adapters** | Persistent storage and retrieval for memories and knowledge | [databaseAdapter](api/interfaces/IAgentRuntime/#databaseAdapter) | [`MongoDB`](https://github.com/elizaos-plugins/adapter-mongodb), [`PostgreSQL`](https://github.com/elizaos-plugins/adapter-postgres), [`SQLite`](https://github.com/elizaos-plugins/adapter-sqlite), [`Supabase`](https://github.com/elizaos-plugins/adapter-supabase), [`PGLite`](https://github.com/elizaos-plugins/adapter-pglite), [`Qdrant`](https://github.com/elizaos-plugins/adapter-qdrant), [`SQL.js`](https://github.com/elizaos-plugins/adapter-sqljs) |
| **Cache Management** | Provides flexible storage and retrieval via various caching methods. | [Cache API](/api/interfaces/ICacheManager) | [`cache.ts`](https://github.com/elizaos/runtime/cache.ts) |



<details>
<summary>Advanced: IAgentRuntime Interface</summary>
```typescript
interface IAgentRuntime {
    // Core identification
    agentId: UUID;
    token: string;
    serverUrl: string;

    // Configuration
    character: Character;                          // Personality and behavior settings
    modelProvider: ModelProviderName;              // AI model to use
    imageModelProvider: ModelProviderName;
    imageVisionModelProvider: ModelProviderName;
    
    // Components
    plugins: Plugin[];                             // Additional capabilities
    clients: Record<string, Client>;               // Platform connections
    providers: Provider[];                         // Real-time data sources
    actions: Action[];                             // Available behaviors
    evaluators: Evaluator[];                       // Analysis & learning
    
    // Memory Management
    messageManager: IMemoryManager;                // Conversation history
    descriptionManager: IMemoryManager;
    documentsManager: IMemoryManager;              // Large documents
    knowledgeManager: IMemoryManager;              // Search & retrieval
    ragKnowledgeManager: IRAGKnowledgeManager;     // RAG integration
    loreManager: IMemoryManager;                   // Character background
    
    // Storage & Caching
    databaseAdapter: IDatabaseAdapter;            // Data persistence
    cacheManager: ICacheManager;                  // Performance optimization
    
    // Services
    services: Map<ServiceType, Service>;          // External integrations
    
    // Networking
    fetch: (url: string, options: any) => Promise<Response>;
}
```
Source: [/api/interfaces/IAgentRuntime/](/api/interfaces/IAgentRuntime/)

</details>


---

### **Key Methods**
- **`initialize()`**: Sets up the agent's runtime environment, including services, plugins, and knowledge processing.
- **`processActions()`**: Executes actions based on message content and state.
- **`evaluate()`**: Assesses messages and state using registered evaluators.
- **`composeState()`**: Constructs the agent's state object for response generation.
- **`updateRecentMessageState()`**: Updates the state with recent messages and attachments.
- **`registerService()`**: Adds a service to the runtime.
- **`registerMemoryManager()`**: Registers a memory manager for specific types of memories.
- **`ensureRoomExists()` / `ensureUserExists()`**: Ensures the existence of rooms and users in the database.

WIP


---

## Service System

Services provide specialized functionality with standardized interfaces that can be accessed cross-platform:

<details>
<summary>See Example</summary>

```typescript
// Speech Generation
const speechService = runtime.getService<ISpeechService>(
    ServiceType.SPEECH_GENERATION
);
const audioStream = await speechService.generate(runtime, text);

// PDF Processing
const pdfService = runtime.getService<IPdfService>(ServiceType.PDF);
const textContent = await pdfService.convertPdfToText(pdfBuffer);
```
</details>


---

## State Management

The runtime maintains comprehensive state through the State interface:

```typescript
interface State {
    // Core identifiers
    userId?: UUID;
    agentId?: UUID;
    roomId: UUID;

    // Character information
    bio: string;
    lore: string;
    messageDirections: string;
    postDirections: string;

    // Conversation context
    actors: string;
    actorsData?: Actor[];
    recentMessages: string;
    recentMessagesData: Memory[];

    // Goals and knowledge
    goals?: string;
    goalsData?: Goal[];
    knowledge?: string;
    knowledgeData?: KnowledgeItem[];
    ragKnowledgeData?: RAGKnowledgeItem[];
}

// State management methods
async function manageState() {
    // Initial state composition
    const state = await runtime.composeState(message, {
        additionalContext: "custom context"
    });

    // Update state with new messages
    const updatedState = await runtime.updateRecentMessageState(state);
}
```

---

## Plugin System

Plugins extend agent functionality through a modular interface. The runtime supports various types of plugins including clients, services, adapters, and more:

```typescript
interface Plugin {
    name: string;
    description: string;
    actions?: Action[];        // Custom behaviors
    providers?: Provider[];    // Data providers
    evaluators?: Evaluator[]; // Response assessment
    services?: Service[];     // Background processes
    clients?: Client[];       // Platform integrations
    adapters?: Adapter[];    // Database/cache adapters
}
```

Plugins can be configured through [characterfile](./characterfile) settings:

```json
{
  "name": "MyAgent",
  "plugins": [
    "@elizaos/plugin-solana",
    "@elizaos/plugin-twitter"
  ]
}
```

For detailed information about plugin development and usage, see the [ElizaOS Registry](https://github.com/elizaos-plugins).

---

## Running Multiple Agents

To run multiple agents:

```bash
pnpm start --characters="characters/agent1.json,characters/agent2.json"
```

Or use environment variables:
```
REMOTE_CHARACTER_URLS=https://example.com/characters.json
```

---

## FAQ

### What's the difference between an agent and a character?

A character defines personality and knowledge, while an agent provides the runtime environment and capabilities to bring that character to life.

### How do I choose the right database adapter?

Choose based on your needs:
- MongoDB: For scalable, document-based storage
- PostgreSQL: For relational data with complex queries
- SQLite: For simple, file-based storage
- Qdrant: For vector search capabilities

### How do I implement custom plugins?

Create a plugin that follows the plugin interface and register it with the runtime. See the plugin documentation for detailed examples.

### Do agents share memory across platforms?
By default, agents maintain separate memory contexts for different platforms to avoid mixing conversations. Use the memory management system and database adapters to persist and retrieve state information.

### How do I handle multiple authentication methods?

Use the character configuration to specify different authentication methods for different services. The runtime will handle the appropriate authentication flow.

### How do I manage environment variables?

Use a combination of:
- `.env` files for local development
- Character-specific settings for per-agent configuration
- Environment variables for production deployment

### Can agents communicate with each other?

Yes, through the message system and shared memory spaces when configured appropriately.
