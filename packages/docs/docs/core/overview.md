---
sidebar_position: 1
title: ElizaOS Documentation
slug: /
---

# ElizaOS Documentation

Welcome to ElizaOS - a comprehensive framework for building AI agents with persistent personalities across multiple platforms. ElizaOS provides the architecture, tools, and systems needed to create sophisticated agents that maintain consistent behavior, learn from interactions, and seamlessly integrate with a variety of services.

## System Architecture

ElizaOS uses a modular architecture that separates concerns while providing a cohesive framework for AI agent development:

```mermaid
graph TB
    %% Main Components with vertical orientation
    User((User)):::user

    %% First Level - Services
    PlatformServices[Services]:::services

    %% Second Level - Runtime
    AgentRuntime[Agent Runtime]:::core

    %% Core Processing Components - Side by side
    subgraph "Core Processing"
        direction LR
        Providers[Providers]:::int
        Actions[Actions]:::int
        Evaluators[Evaluators]:::int
    end

    %% Knowledge and DB - Side by side
    subgraph "Knowledge & Storage"
        direction LR
        Knowledge[Knowledge]:::int
        DB[(Database)]:::db
    end

    %% Organization Components - Vertical layout
    subgraph "Organization"
        direction TB
        Worlds[Worlds]:::struct
        Rooms[Rooms]:::struct
        Entities[Entities]:::struct
    end

    %% Development Components - Side by side
    subgraph "Development & Integration"
        direction LR
        Plugins[Plugins]:::dev
        Projects[Projects]:::dev
        Tasks[Tasks]:::dev
    end

    %% Main Flow - Vertical emphasis
    User <-->|Interaction| PlatformServices
    PlatformServices -->|Process| AgentRuntime

    %% Runtime connections - Simplified
    AgentRuntime ---|Context| Providers
    AgentRuntime ---|Behavior| Actions
    AgentRuntime ---|Analysis| Evaluators

    %% Data connections
    AgentRuntime <-->|Storage| DB
    Knowledge -->|Informs| Providers

    %% Structure connections - Clean vertical hierarchy
    AgentRuntime -->|Manages| Worlds
    Worlds -->|Contains| Rooms
    Rooms -->|Has| Entities

    %% Development connections
    Projects -->|Configure| AgentRuntime
    Plugins -->|Extend| AgentRuntime
    Tasks -->|Scheduled by| AgentRuntime

    %% Clickable nodes with links to docs
    click AgentRuntime "/docs/core/agents" "Learn about Agent Runtime"
    click PlatformServices "/docs/core/services" "Learn about Services"
    click DB "/docs/core/database" "Learn about Database Systems"
    click Actions "/docs/core/actions" "Learn about Actions"
    click Providers "/docs/core/providers" "Learn about Providers"
    click Evaluators "/docs/core/evaluators" "Learn about Evaluators"
    click Knowledge "/docs/core/knowledge" "Learn about Knowledge System"
    click Worlds "/docs/core/worlds" "Learn about Worlds"
    click Rooms "/docs/core/rooms" "Learn about Rooms"
    click Entities "/docs/core/entities" "Learn about Entities"
    click Plugins "/docs/core/plugins" "Learn about Plugins"
    click Projects "/docs/core/project" "Learn about Projects"
    click Tasks "/docs/core/tasks" "Learn about Tasks"

    %% Styling
    classDef core fill:#3498db,stroke:#2c3e50,stroke-width:1px,color:#fff,font-weight:bold
    classDef services fill:#9b59b6,stroke:#2c3e50,stroke-width:1px,color:#fff,font-weight:bold
    classDef db fill:#27ae60,stroke:#2c3e50,stroke-width:1px,color:#fff,font-weight:bold
    classDef int fill:#e74c3c,stroke:#2c3e50,stroke-width:1px,color:#fff,font-weight:bold
    classDef struct fill:#f39c12,stroke:#2c3e50,stroke-width:1px,color:#fff,font-weight:bold
    classDef dev fill:#1abc9c,stroke:#2c3e50,stroke-width:1px,color:#fff,font-weight:bold
    classDef user fill:#ecf0f1,stroke:#2c3e50,stroke-width:2px,color:#2c3e50,font-weight:bold,border-radius:50%
```

### How ElizaOS Works

When a user message is received:

1. **Service Reception**: Platform service (Discord, Telegram, etc.) receives the message
2. **Runtime Processing**: Agent runtime coordinates the response generation
3. **Context Building**: Providers supply relevant context (time, recent messages, knowledge)
4. **Action Selection**: The agent evaluates and selects appropriate actions
5. **Response Generation**: The chosen action generates a response
6. **Learning & Reflection**: Evaluators analyze the conversation for insights and learning
7. **Memory Storage**: New information is stored in the database
8. **Response Delivery**: The response is sent back through the service

This creates a continuous cycle of interaction, reflection, and improvement that allows agents to maintain consistent personalities while adapting to new information.

## Core Components

<div className="container">
  <div className="row">
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/agentruntime.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>🤖 Agent Runtime</h3>
          <p>The central system that orchestrates agent behavior, processes messages, manages state, and coordinates all other components.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/agents">Agent Runtime</a>
        </div>
      </div>
    </div>
    
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/services.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>📚 Services</h3>
          <p>Platform-specific integrations that enable agents to communicate across Discord, Twitter, Telegram, and other channels.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/services">Services</a>
        </div>
      </div>
    </div>
    
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/database.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>💾 Database</h3>
          <p>Persistent storage for memories, entity data, relationships, and configuration using vector search capabilities.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/database">Database</a>
        </div>
      </div>
    </div>
  </div>
</div>

## Intelligence & Behavior

<div className="container">
  <div className="row">
    <div className="col col--3 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/actions.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>⚡ Actions</h3>
          <p>Executable capabilities that define how agents respond to messages and interact with external systems.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/actions">Actions</a>
        </div>
      </div>
    </div>
    
    <div className="col col--3 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/providers.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>🔌 Providers</h3>
          <p>Data sources that supply contextual information to inform agent decision-making in real-time.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/providers">Providers</a>
        </div>
      </div>
    </div>
    
    <div className="col col--3 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/evaluators.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>📊 Evaluators</h3>
          <p>Analytical systems that process conversations to extract insights, learn facts, and improve future responses.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/evaluators">Evaluators</a>
        </div>
      </div>
    </div>
    
    <div className="col col--3 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/knowledge.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>🧠 Knowledge</h3>
          <p>RAG system for document processing, semantic search, and context-aware memory retrieval.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/knowledge">Knowledge</a>
        </div>
      </div>
    </div>
  </div>
</div>

## Structure & Organization

<div className="container">
  <div className="row">
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/worlds.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>🌐 Worlds</h3>
          <p>Collection spaces that organize entities and rooms into coherent environments (like a Discord server).</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/worlds">Worlds</a>
        </div>
      </div>
    </div>
    
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/rooms.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>💬 Rooms</h3>
          <p>Conversation spaces where entities interact through messages (channels, DMs, threads).</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/rooms">Rooms</a>
        </div>
      </div>
    </div>
    
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/entities.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>👤 Entities</h3>
          <p>Representation of users, agents, and other participants using a flexible entity-component architecture.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/entities">Entities</a>
        </div>
      </div>
    </div>
  </div>
</div>

## Development & Integration

<div className="container">
  <div className="row">
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/plugins.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>🧩 Plugins</h3>
          <p>Modular extensions that add new capabilities, integrations, and behaviors to agents.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/plugins">Plugins</a>
        </div>
      </div>
    </div>
    
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/project.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>📝 Projects</h3>
          <p>Organizational structure for defining and deploying one or more agents with their configuration.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/project">Projects</a>
        </div>
      </div>
    </div>
    
    <div className="col col--4 margin-bottom--lg">
      <div className="card">
        <div className="card__image">
          <img src="/img/tasks.jpg?text=🔍" alt="Overview" />
        </div>      
        <div className="card__body">
          <h3>📋 Tasks</h3>
          <p>System for managing deferred, scheduled, and repeating operations across conversations.</p>
        </div>
        <div className="card__footer">
          <a className="button button--primary button--block" href="/docs/core/tasks">Tasks</a>
        </div>
      </div>
    </div>
  </div>
</div>

---

## Key Concepts

### Action-Provider-Evaluator Cycle

The core of the ElizaOS system operates as a continuous cycle:

1. **Providers** gather context before response generation
2. **Actions** determine what the agent can do and are executed to generate responses
3. **Evaluators** analyze conversations after responses to extract insights
4. These insights become part of the agent's memory
5. Future **Providers** access this memory to inform new responses

This creates a virtuous cycle where agents continuously learn and improve from interactions.

### Entity-Component Architecture

ElizaOS uses an entity-component architecture for flexible data modeling:

- **Entities** are base objects with unique IDs (users, agents, etc.)
- **Components** are pieces of data attached to entities (profiles, settings, etc.)
- This approach allows for dynamic composition without complex inheritance hierarchies

### Memory System

The memory system in ElizaOS provides:

- **Vector-based semantic search** for finding relevant memories
- **Multi-level memory types** (messages, facts, knowledge)
- **Temporal awareness** through timestamped memories
- **Cross-platform continuity** while maintaining appropriate context boundaries

## Getting Started

If you're new to ElizaOS, we recommend this learning path:

1. Start with this overview to understand the system architecture
2. Explore the [Agent Runtime](/docs/core/agents) to understand the core system
3. Learn about [Projects](/docs/core/project) to set up your development environment
4. Understand how [Actions](/docs/core/actions) and [Providers](/docs/core/providers) work together
5. Explore [Services](/docs/core/services) to connect with external platforms
6. Dive into [Plugins](/docs/core/plugins) to extend functionality

## FAQ

<details>
<summary><b>What's the difference between Actions, Evaluators, and Providers?</b></summary>

**Actions** define what an agent can do and are executed during response generation. **Evaluators** analyze conversations after they happen to extract insights and improve future responses. **Providers** supply contextual information before the agent decides how to respond.

</details>

<details>
<summary><b>How does ElizaOS handle cross-platform conversation context?</b></summary>

ElizaOS maintains separate conversation contexts for different platforms by default, but shares entity relationships and learned facts across platforms. This ensures agents maintain a consistent understanding of users while respecting platform-specific conversation boundaries.

</details>

<details>
<summary><b>How does the memory system work?</b></summary>

Memory is organized into different types (messages, facts, knowledge) and stored with vector embeddings for semantic search. This allows agents to retrieve relevant memories based on context rather than just recency, creating more natural conversations.

</details>

<details>
<summary><b>What's the relationship between Worlds, Rooms, and Entities?</b></summary>

Worlds are container spaces (like a Discord server) that can have multiple Rooms (channels, DMs). Entities (users, agents) participate in Rooms within Worlds. This hierarchical structure mirrors real-world platforms while providing a consistent abstraction.

</details>

<details>
<summary><b>How extensible is ElizaOS?</b></summary>

ElizaOS is highly extensible through its plugin system. You can create custom actions, providers, evaluators, services, and more to extend functionality. The architecture is designed to be modular and composable at every level.

</details>

## Additional Resources

- [API Reference](/api) - Detailed API documentation for developers
- [GitHub Repository](https://github.com/elizaos/eliza) - Source code and contributions
- [Package Showcase](/packages) - Explore available plugins and extensions
