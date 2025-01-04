---
sidebar_position: 2
---

# 🤖 Agents

Agents are the core components of the Eliza framework that handle autonomous interactions. Each agent runs in a runtime environment and can interact through various clients (Discord, Telegram, etc.) while maintaining consistent behavior and memory.

---

## Overview

The [AgentRuntime](/api/classes/AgentRuntime) class is the primary implementation of the [IAgentRuntime](/api/interfaces/IAgentRuntime) interface, which manages the agent's core functions, including:

- **Message and Memory Processing**: Storing, retrieving, and managing conversation data and contextual memory.
- **State Management**: Composing and updating the agent’s state for a coherent, ongoing interaction.
- **Action Execution**: Handling behaviors such as transcribing media, generating images, and following rooms.
- **Evaluation and Response**: Assessing responses, managing goals, and extracting relevant information.

---

## Core Components

Each agent runtime consists of key components that enable flexible and extensible functionality:

1. **Clients**: Enable communication across platforms such as Discord, Telegram, and Direct (REST API), with features tailored for each platform.
2. **Providers**: Extend the agent’s capabilities by integrating with additional services (e.g., time, wallet, or custom data).
3. **Actions**: Define agent behaviors, such as following rooms, generating images, or processing attachments. Custom actions can be created to tailor behaviors to specific needs.
4. **Evaluators**: Manage agent responses by assessing message relevance, managing goals, extracting facts, and building long-term memory.

### AgentRuntime Interface

The `IAgentRuntime` interface defines the main structure of the runtime environment, specifying the configuration and essential components:

```typescript
interface IAgentRuntime {
    // Core identification
    agentId: UUID;
    serverUrl: string;
    token: string;

    // Configuration
    character: Character;
    modelProvider: ModelProviderName;

    // Components
    actions: Action[];
    evaluators: Evaluator[];
    providers: Provider[];

    // Database & Memory
    databaseAdapter: IDatabaseAdapter;
    messageManager: IMemoryManager;
    descriptionManager: IMemoryManager;
    loreManager: IMemoryManager;
}
```

Each element in the runtime interface plays a crucial role:

- **Identification**: Agent ID, server URL, and token for authentication and identification.
- **Configuration**: Character profile and model provider define the agent's personality and language model.
- **Components**: Actions, evaluators, and providers support extensible behaviors, response evaluation, and service integration.
- **Memory Management**: Specialized memory managers track conversations, descriptions, and static knowledge to enable contextual and adaptive responses.

---

## Creating an Agent Runtime

This section demonstrates setting up an agent with basic and optional configurations. It provides a working example and sample code that helps users quickly start building:

```typescript
import { AgentRuntime, ModelProviderName } from "@elizaos/core";

// Configuration example
const runtime = new AgentRuntime({
    token: "auth-token",
    modelProvider: ModelProviderName.ANTHROPIC,
    character: characterConfig,
    databaseAdapter: new DatabaseAdapter(),
    conversationLength: 32,
    serverUrl: "http://localhost:7998",
    actions: customActions,
    evaluators: customEvaluators,
    providers: customProviders,
});
```

---

## State Management

This section covers how agents manage and update state, with a focus on initial state composition and updating methods. The runtime maintains state through the [State](/api/interfaces/state) interface:

```typescript
interface State {
    userId?: UUID;
    agentId?: UUID;
    roomId: UUID;
    bio: string;
    lore: string;
    agentName?: string;
    senderName?: string;
    actors: string;
    actorsData?: Actor[];
    recentMessages: string;
    recentMessagesData: Memory[];
    goals?: string;
    goalsData?: Goal[];
    actions?: string;
    actionNames?: string;
    providers?: string;
}
```

State composition and updates are handled through dedicated methods:

```typescript
// Compose initial state
const state = await runtime.composeState(message, {
    additionalContext: "custom-context",
});

// Update message state
const updatedState = await runtime.updateRecentMessageState(state);
```

**Best practices**

- Keep state immutable where possible
- Use `composeState` for initial state creation
- Use `updateRecentMessageState` for updates
- Cache frequently accessed state data

---

## Memory Systems

The Eliza framework uses multiple types of memory to support an agent's long-term engagement, contextual understanding, and adaptive responses. Each type of memory serves a specific purpose:

- **Message History**: Stores recent conversations to provide continuity within a session. This helps the agent maintain conversational context and avoid repetitive responses within short-term exchanges.

- **Factual Memory**: Holds specific, context-based facts about the user or environment, such as user preferences, recent activities, or specific details mentioned in previous interactions. This type of memory enables the agent to recall user-specific information across sessions.

- **Knowledge Base**: Contains general knowledge the agent might need to respond to broader queries or provide informative answers. This memory is more static, helping the agent retrieve pre-defined data, common responses, or static character lore.

- **Relationship Tracking**: Manages the agent’s understanding of its relationship with users, including details like user-agent interaction frequency, sentiment, and connection history. It is particularly useful for building rapport and providing a more personalized interaction experience over time.

- **RAG Integration**: Uses a vector search to perform contextual recall based on similarity matching. This enables the agent to retrieve relevant memory snippets or knowledge based on the content and intent of the current conversation, making its responses more contextually relevant.

The runtime uses multiple specialized [IMemoryManager](/api/interfaces/IMemoryManager) instances:

- `messageManager` - conversation messages and responses
- `descriptionManager` - user descriptions and profiles
- `loreManager` - static character knowledge

---

## Message Processing

The runtime's message processing is handled through the [processActions](/api/classes/AgentRuntime#processactions) method:

```typescript
// Process message with actions
await runtime.processActions(message, responses, state, async (newMessages) => {
    // Handle new messages
    return [message];
});
```

---

## Services and Memory Management

Services are managed through the [getService](/api/classes/AgentRuntime#getservice) and [registerService](/api/classes/AgentRuntime#registerservice) methods:

```typescript
// Register service
runtime.registerService(new TranscriptionService());

// Get service
const service = runtime.getService<ITranscriptionService>(
    ServiceType.TRANSCRIPTION,
);
```

### Memory Management

Memory managers are accessed via [getMemoryManager](/api/classes/AgentRuntime#getmemorymanager):

```typescript
// Get memory manager
const memoryManager = runtime.getMemoryManager("messages");

// Create memory
await memoryManager.createMemory({
    id: messageId,
    content: { text: "Message content" },
    userId: userId,
    roomId: roomId,
});
```

**Best practices**

- Use appropriate memory managers for different data types
- Consider memory limits when storing data, regularly clean up memory
- Use the `unique` flag for deduplicated storage
- Clean up old memories periodically
- Use immutability in state management.
- Log errors and maintain stability during service failures.

---

## Evaluation System

The runtime's [evaluate](/api/classes/AgentRuntime#evaluate) method processes evaluations:

```typescript
// Evaluate message
const evaluationResults = await runtime.evaluate(message, state, didRespond);
```

---

## Usage Examples

1. **Message Processing**:

```typescript
await runtime.processActions(message, responses, state, (newMessages) => {
    return [message];
});
```

2. **State Management**:

```typescript
const state = await runtime.composeState(message, {
    additionalContext: "custom-context",
});
```

3. **Memory Management**:

```typescript
const memoryManager = runtime.getMemoryManager("messages");
await memoryManager.createMemory({
    id: messageId,
    content: { text: "Message content" },
    userId,
    roomId,
});
```

---

## Further Reading

- [Actions Documentation](./actions.md)
- [Evaluators Documentation](./evaluators.md)
- [Providers Documentation](./providers.md)
- [Full API Reference](/api)
