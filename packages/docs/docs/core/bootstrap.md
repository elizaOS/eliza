---
sidebar_position: 11
---

# Bootstrap Plugin

The Bootstrap Plugin is a foundational component of ElizaOS that initializes the core functionality required for agents to operate. It provides the default set of actions, providers, evaluators, event handlers, and services that form the backbone of the agent runtime.

## Overview

When an ElizaOS agent starts, the Bootstrap Plugin is automatically loaded as part of the initialization process. It establishes the minimum viable set of capabilities that all agents need, ensuring consistency across the platform while still allowing for customization through additional plugins.

```typescript
export const bootstrapPlugin: Plugin = {
  name: 'bootstrap',
  description: 'Agent bootstrap with basic actions and evaluators',
  actions: [...],
  events: {...},
  evaluators: [...],
  providers: [...],
  services: [TaskService, ScenarioService],
};
```

## Core Components

### Actions

The Bootstrap Plugin registers essential actions that allow agents to interact with their environment:

| Action                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `replyAction`          | Generates and sends a response to a message     |
| `followRoomAction`     | Enables an agent to actively follow a room      |
| `unfollowRoomAction`   | Stops an agent from following a room            |
| `muteRoomAction`       | Mutes notifications from a room                 |
| `unmuteRoomAction`     | Unmutes notifications from a room               |
| `sendMessageAction`    | Sends a message to a specific room              |
| `ignoreAction`         | Explicitly ignores a message                    |
| `noneAction`           | Acknowledges a message without taking action    |
| `updateEntityAction`   | Updates properties of an entity                 |
| `choiceAction`         | Presents choices to users and handles responses |
| `updateRoleAction`     | Updates a user's role in a world                |
| `updateSettingsAction` | Updates agent or world settings                 |

### Providers

Providers supply contextual information to agents as they make decisions:

| Provider                 | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `characterProvider`      | Provides the agent's personality and configuration         |
| `recentMessagesProvider` | Retrieves recent conversation history                      |
| `knowledgeProvider`      | Supplies factual information from the knowledge base       |
| `timeProvider`           | Provides awareness of current time and date                |
| `entitiesProvider`       | Supplies information about entities in the current context |
| `relationshipsProvider`  | Provides information about entity relationships            |
| `factsProvider`          | Retrieves relevant facts from memory                       |
| `roleProvider`           | Provides role information within worlds                    |
| `settingsProvider`       | Supplies configured settings                               |
| `anxietyProvider`        | Informs agent of potential issues to be careful about      |
| `attachmentsProvider`    | Handles media and file attachments                         |
| `providersProvider`      | Meta-provider with information about available providers   |
| `actionsProvider`        | Meta-provider with information about available actions     |
| `evaluatorsProvider`     | Meta-provider with information about available evaluators  |
| `choiceProvider`         | Manages choice-based interactions                          |
| `capabilitiesProvider`   | Provides information about agent capabilities              |

### Evaluators

Evaluators analyze conversations to help agents learn and improve:

| Evaluator             | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `reflectionEvaluator` | Enables self-awareness and learning from interactions |

### Event Handlers

The Bootstrap Plugin registers handlers for key system events:

| Event                                       | Handler Purpose                                     |
| ------------------------------------------- | --------------------------------------------------- |
| `MESSAGE_RECEIVED`                          | Processes incoming messages and generates responses |
| `VOICE_MESSAGE_RECEIVED`                    | Handles voice messages similarly to text messages   |
| `REACTION_RECEIVED`                         | Records reactions to messages                       |
| `POST_GENERATED`                            | Handles social media post creation                  |
| `MESSAGE_SENT`                              | Tracks outgoing messages                            |
| `WORLD_JOINED`                              | Synchronizes data when joining a new world          |
| `WORLD_CONNECTED`                           | Handles reconnection to an existing world           |
| `ENTITY_JOINED`                             | Processes a new entity joining a world              |
| `ENTITY_LEFT`                               | Updates an entity's status when they leave          |
| `ACTION_STARTED` / `ACTION_COMPLETED`       | Logs action lifecycle events                        |
| `EVALUATOR_STARTED` / `EVALUATOR_COMPLETED` | Logs evaluator lifecycle events                     |

### Services

The Bootstrap Plugin initializes core services:

| Service           | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `TaskService`     | Manages deferred, scheduled, and repeating tasks |
| `ScenarioService` | Handles scenario-based interactions and testing  |

## Loading Process

The AgentRuntime automatically loads the Bootstrap Plugin during initialization, before any other plugins. This happens in the `initialize()` method of the AgentRuntime:

```typescript
async initialize() {
  // Register bootstrap plugin
  await this.registerPlugin(bootstrapPlugin);

  // Then register additional plugins
  for (const plugin of this.plugins) {
    await this.registerPlugin(plugin);
  }

  // Initialize other components
  // ...
}
```

## Extending Bootstrap Functionality

While the Bootstrap Plugin provides core functionality, it's designed to be extended by other plugins. Custom plugins can:

1. **Add new actions** - Extend the agent's capabilities
2. **Register additional providers** - Supply more contextual information
3. **Add evaluators** - Create new ways to analyze and learn from interactions
4. **Handle additional events** - React to more system events
5. **Initialize custom services** - Provide new functionality

## Message Processing Flow

The Bootstrap Plugin implements the critical message processing flow:

1. A message is received via the `MESSAGE_RECEIVED` event
2. The `messageReceivedHandler` function processes the message:
   - Saves the incoming message to memory
   - Checks if the agent should respond based on context and configuration
   - If a response is needed, composes state from relevant providers
   - Generates a response using the language model
   - Processes any actions specified in the response
   - Runs evaluators on the conversation
   - Emits events about the processing lifecycle

This flow is central to agent behavior and provides the core functionality that enables interactive, stateful conversations.

## Relationship with Other Core Concepts

The Bootstrap Plugin connects several key ElizaOS concepts:

- **Agent Runtime**: The plugin is loaded by the runtime and extends its capabilities
- **Plugins**: Bootstrap is itself a plugin and demonstrates the plugin architecture
- **Actions, Providers, Evaluators**: Provides the core implementations of these concepts
- **Events**: Establishes the event handling system that enables agent reactivity
- **Worlds and Rooms**: Includes handlers for synchronizing these structures
- **Entities**: Provides actions and providers for entity management
- **Tasks**: Initializes the task system for deferred operations

## Best Practices

When working with the Bootstrap Plugin:

1. **Don't modify it directly** - Instead, create custom plugins to extend functionality
2. **Understand provider contribution** - Know how each provider contributes to the agent's context
3. **Learn the core actions** - Become familiar with the actions that all agents can perform
4. **Leverage event handlers** - Use the event system for reactive behavior
5. **Extend, don't replace** - Build on top of bootstrap functionality rather than replacing it

## Related Documentation

- [Actions](./actions.md) - Details on action implementation
- [Providers](./providers.md) - Learn about context providers
- [Evaluators](./evaluators.md) - Understanding evaluator functionality
- [Plugin System](./plugins.md) - How plugins extend ElizaOS
- [Events](./events.md) - The event system architecture
