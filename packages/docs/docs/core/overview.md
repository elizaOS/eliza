---
sidebar_position: 1
---

# Overview

ElizaOS is a framework for creating AI agents that can interact across multiple platforms through a consistent, extensible architecture.

## Core Features

- **Modular Architecture**: A plugin-based system for extending functionality
- **Entity-Component System**: Flexible data modeling for agents and users
- **Vector-Based Memory**: Semantic retrieval of conversations and knowledge
- **Multi-Modal Interactions**: Support for text, voice, images, and other media formats
- **Reflection & Self-Improvement**: Agents learn from interactions and adapt over time
- **Cross-Platform Integration**: Connect to multiple services through a unified interface

## Key Components

ElizaOS consists of these core architectural components:

![](/img/system-architecture.png)

### [Agent Runtime](./agents.md)

The Agent Runtime is the central nervous system of ElizaOS. It orchestrates all components, manages state, processes messages, and coordinates the agent's behavior.

**Responsibilities:**

- Lifecycle management
- Service coordination
- Memory management
- State composition
- Action execution
- Model integration

### [Projects](./project.md)

Projects are the top-level containers that define one or more agents, their configurations, and shared resources. A project:

- Defines agent characters and behavior
- Configures plugins and services
- Sets up knowledge and memory systems
- Establishes shared worlds and environments

### [Entities & Components](./entities.md)

ElizaOS uses an entity-component architecture for flexible data modeling:

- **Entities**: Base objects with unique identifiers (agents, users, etc.)
- **Components**: Modular data attached to entities (profiles, settings, etc.)

This architecture allows for dynamic composition of objects and extensible data models without complex inheritance hierarchies.

### [Services](./services.md)

Services connect agents to different platforms (Discord, X/Twitter, Telegram, etc.) and provide specialized capabilities:

- **Platform Services**: Connect to external platforms
- **Core Services**: Provide essential functionality (speech, vision, etc.)
- **Extension Services**: Add specialized capabilities

Services use a consistent interface but can provide platform-specific features when needed.

### [Actions](./actions.md)

Actions define how agents respond to messages and interact with the world:

- **Communication Actions**: Generate responses and engage in conversation
- **Integration Actions**: Interact with external systems and APIs
- **Media Actions**: Generate and process images, audio, and other media
- **Platform Actions**: Leverage platform-specific features

Each action includes validation logic, a handler function, and thought processes that explain the agent's reasoning.

### [Providers](./providers.md)

Providers supply contextual information to agents as they make decisions:

- **Memory Providers**: Access relevant conversation history
- **Knowledge Providers**: Supply factual information
- **State Providers**: Provide current context and environment details
- **Temporal Providers**: Manage time-based awareness

Providers are dynamically composed to create a comprehensive context for agent decision-making.

### [Evaluators](./evaluators.md)

Evaluators analyze conversations after they happen, helping agents learn and improve:

- **Reflection Evaluator**: Enables self-awareness and improvement
- **Fact Evaluator**: Extracts factual information from conversations
- **Goal Evaluator**: Tracks progress on objectives
- **Relationship Evaluator**: Models connections between entities

Evaluators create a feedback loop for continuous agent improvement.

### [Plugins](./plugins.md)

Plugins extend ElizaOS with new capabilities by adding services, actions, providers, evaluators, and more:

- **Core Plugins**: Essential functionality for all agents
- **Platform Plugins**: Integrations with external platforms
- **Capability Plugins**: Special abilities like blockchain interaction
- **Utility Plugins**: Tools for specific tasks or domains

Plugins use a consistent installation and configuration pattern.

## Data Systems

### [Database System](./database.md)

ElizaOS uses a flexible adapter-based database system:

- **Entity Storage**: Manages entity and component data
- **Memory System**: Stores conversations and extracted facts
- **Vector Search**: Enables semantic retrieval of information
- **Relationship Tracking**: Maps connections between entities
- **World & Room Management**: Organizes conversation spaces

The current implementation supports PGLite (for development) and PostgreSQL (for production) using Drizzle ORM.

### [Knowledge System](./knowledge.md)

The knowledge system enables agents to access and use structured information:

- **Document Processing**: Converts various file formats into usable knowledge
- **RAG Implementation**: Retrieval-Augmented Generation for contextual responses
- **Semantic Search**: Finds relevant information through vector similarity
- **Memory Integration**: Combines knowledge with conversation memory

## Structural Elements

### [Worlds](./worlds.md)

Worlds are containers for agents, rooms, and shared resources that provide:

- Namespace isolation
- Resource sharing
- Multi-agent environments
- Context boundaries

### [Rooms](./rooms.md)

Rooms are conversation spaces where entities interact:

- Direct messages between entities
- Group conversations
- Platform-specific channels
- Persistent conversation history

### [Tasks](./tasks.md)

The task system enables asynchronous processing and scheduled operations:

- Background processing
- Scheduled activities
- Workflow management
- Event-driven operations

## System Flow

When a message is received:

1. The **Service** receives the input and forwards it to the **Runtime**
2. The **Runtime** loads the agent configuration from the **Project**
3. **Providers** supply context (memories, knowledge, state)
4. Valid **Actions** are identified through validation functions
5. The agent decides on a response, including internal **thoughts**
6. The response is returned through the **Service**
7. **Evaluators** analyze the conversation for insights
8. New memories and relationships are stored in the **Database**

This creates a continuous cycle of interaction, reflection, and improvement.

## Common Patterns

### Creating an Agent Response

```typescript
// The agent runtime processes a message and generates a response
const result = await runtime.processMessage({
  entityId: senderId,
  roomId: channelId,
  content: { text: 'Hello, how are you?' },
});

// The response includes thought process and actions
console.log(result.thought); // Internal reasoning (not shown to user)
console.log(result.text); // The actual response
console.log(result.actions); // Actions performed
```

### Storing and Retrieving Memories

```typescript
// Store a memory
await runtime.createMemory(
  {
    entityId: userId,
    roomId: channelId,
    content: { text: 'Important information' },
    embedding: await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: 'Important information',
    }),
  },
  'facts'
);

// Retrieve relevant memories
const memories = await runtime.searchMemories({
  tableName: 'messages',
  roomId: channelId,
  embedding: embedding,
  count: 5,
});
```

### Creating a Relationship Between Entities

```typescript
// Establish a relationship
await runtime.createRelationship({
  sourceEntityId: userEntityId,
  targetEntityId: agentEntityId,
  tags: ['friend', 'frequent_interaction'],
  metadata: {
    interactions: 12,
    trust_level: 'high',
  },
});
```

## FAQ

### What's the difference between Actions, Evaluators, and Providers?

**Actions** define what an agent can do and are executed during response generation. **Evaluators** analyze conversations after they happen to extract insights and improve future responses. **Providers** supply contextual information before the agent decides how to respond.

### How do agent thoughts relate to evaluator reflections?

Agent **thoughts** are generated during response creation to explain reasoning in the moment. Evaluator **reflections** happen after responses, analyzing longer-term patterns and extracting insights for future interactions.

### How is memory organized in ElizaOS?

Memory is organized into different types (messages, facts, knowledge) and stored with vector embeddings for semantic search. This allows agents to retrieve relevant memories based on context rather than just recency.

### How does the entity-component system work?

The entity-component system provides a flexible way to model data. **Entities** are base objects with unique IDs, while **Components** are pieces of data attached to entities. This allows for dynamic composition without complex inheritance.

### How do I extend an agent with new capabilities?

Create or install plugins that provide new actions, services, providers, or evaluators. Plugins can be registered in the project configuration and will be automatically loaded when the agent starts.

### What model providers are supported?

ElizaOS supports multiple model providers including OpenAI, Anthropic, and local models. The model provider is configured at the project level and can be overridden for specific operations.

### How do I configure the database?

ElizaOS currently supports PostgreSQL (recommended for production) and PGLite (for development). Configure the connection using environment variables like `POSTGRES_URL` or `PGLITE_DATA_DIR`.

### How do services differ from the old "clients"?

Services provide a more comprehensive integration model than the previous "clients" concept. They offer standardized interfaces for various platforms while allowing for platform-specific features and optimizations.

## Getting Started

To create your first ElizaOS project, see the [Quick Start Guide](../quickstart.md) or explore the [Tutorials](../tutorials/your-first-agent.md) section.
