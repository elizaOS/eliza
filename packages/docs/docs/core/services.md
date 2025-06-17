---
sidebar_position: 3
title: Services System
description: Understanding ElizaOS services - core components that enable AI agents to interact with external platforms
keywords: [services, platforms, integration, Discord, Twitter, Telegram, communication, API]
image: /img/services.jpg
---

# 🔌 Services

Services are core components in ElizaOS that enable AI agents to interact with external platforms and services. Each service provides a specialized interface for communication while maintaining consistent agent behavior across different platforms.

## Service Architecture

Services in ElizaOS follow a standardized architecture:

```typescript
export abstract class Service {
  protected runtime!: IAgentRuntime;
  static serviceType: string;
  abstract capabilityDescription: string;
  config?: Metadata;

  constructor(runtime?: IAgentRuntime) {
    if (runtime) {
      this.runtime = runtime;
    }
  }

  abstract stop(): Promise<void>;

  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error('Not implemented');
  }
}
```

## Core Service Types

The system defines the following service types in the `ServiceType` registry:

```typescript
export const ServiceType = {
  TRANSCRIPTION: 'transcription',
  VIDEO: 'video',
  BROWSER: 'browser',
  PDF: 'pdf',
  REMOTE_FILES: 'aws_s3',
  WEB_SEARCH: 'web_search',
  EMAIL: 'email',
  TEE: 'tee',
  TASK: 'task',
  WALLET: 'wallet',
  LP_POOL: 'lp_pool',
  TOKEN_DATA: 'token_data',
  DATABASE_MIGRATION: 'database_migration',
  PLUGIN_MANAGER: 'PLUGIN_MANAGER',
  PLUGIN_CONFIGURATION: 'PLUGIN_CONFIGURATION',
  PLUGIN_USER_INTERACTION: 'PLUGIN_USER_INTERACTION',
} as const;
```

## Built-in Services

### Task Service

The Task Service (provided by `@elizaos/plugin-bootstrap`) manages scheduled and queued tasks:

```typescript
export class TaskService extends Service {
  static serviceType = ServiceType.TASK;
  capabilityDescription = 'The agent is able to schedule and execute tasks';

  // Checks for tasks every second
  private readonly TICK_INTERVAL = 1000;
}
```

Features:

- Scheduled task execution
- Repeating tasks with intervals
- One-time task execution
- Task validation and worker registration

### Platform Services

Platform-specific services are provided by their respective plugins:

| Service  | Plugin                     | Description                                      |
| -------- | -------------------------- | ------------------------------------------------ |
| Twitter  | `@elizaos/plugin-twitter`  | Twitter/X integration for posting and engagement |
| Telegram | `@elizaos/plugin-telegram` | Telegram bot functionality                       |
| Discord  | `@elizaos/plugin-discord`  | Discord server and DM integration                |
| MCP      | `@elizaos/plugin-mcp`      | Model Context Protocol integration               |

### Infrastructure Services

| Service    | Type         | Description                           |
| ---------- | ------------ | ------------------------------------- |
| Knowledge  | `knowledge`  | RAG-based knowledge management        |
| EVM        | `evm`        | Ethereum Virtual Machine interactions |
| Wallet     | `wallet`     | Cryptocurrency wallet management      |
| Token Data | `token_data` | Token information and analytics       |

## Service Registration

Services are registered through plugins during runtime initialization:

```typescript
// In your plugin
export const myPlugin: Plugin = {
  name: 'my-plugin',
  services: [MyService], // Array of service classes
  // ... other plugin properties
};
```

The runtime automatically:

1. Instantiates services during plugin registration
2. Calls the service's `start()` method
3. Manages service lifecycle
4. Provides access via `runtime.getService()`

## Using Services

### Getting a Service

```typescript
// Type-safe service retrieval
const taskService = runtime.getService<TaskService>(ServiceType.TASK);

// Check if service exists
if (runtime.hasService(ServiceType.TASK)) {
  // Service is available
}

// Get all registered services
const allServices = runtime.getAllServices();
```

### Creating a Custom Service

```typescript
import { Service, ServiceType, IAgentRuntime } from '@elizaos/core';

export class MyCustomService extends Service {
  static serviceType = 'my_custom_service';
  capabilityDescription = 'Provides custom functionality';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    // Initialize your service
  }

  static async start(runtime: IAgentRuntime): Promise<MyCustomService> {
    const service = new MyCustomService(runtime);
    // Perform async initialization
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    // Cleanup resources
    // Close connections
    // Cancel timers
  }

  private async initialize(): Promise<void> {
    // Setup code
  }

  // Add your service methods
  async performAction(params: any): Promise<any> {
    // Service logic
  }
}
```

### Extending Service Types

Plugins can extend the service type registry via module augmentation:

```typescript
// In your plugin
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    MY_CUSTOM_SERVICE: 'my_custom_service';
  }
}
```

## Service Lifecycle

1. **Registration**: Services are registered when their containing plugin is loaded
2. **Initialization**: The `start()` method is called during runtime initialization
3. **Operation**: Services remain active throughout the agent's lifetime
4. **Shutdown**: The `stop()` method is called when the runtime stops

```typescript
// Service lifecycle in runtime
async initialize(): Promise<void> {
  // ... other initialization

  // Start queued services
  for (const service of this.servicesInitQueue) {
    await this.registerService(service);
  }

  this.isInitialized = true;
}

async stop(): Promise<void> {
  // Stop all services
  for (const [serviceName, service] of this.services) {
    await service.stop();
  }
}
```

## Service Communication

Services can:

- Access other services via the runtime
- Emit and listen to events
- Share state through the runtime
- Coordinate through the task system

```typescript
// Service accessing another service
class MyService extends Service {
  async doSomething() {
    const taskService = this.runtime.getService<TaskService>(ServiceType.TASK);
    if (taskService) {
      // Create a task
      await this.runtime.createTask({
        name: 'MY_TASK',
        description: 'Task created by MyService',
        metadata: { source: 'MyService' },
      });
    }
  }
}
```

## Best Practices

1. **Service Independence**: Services should be self-contained and not directly depend on other services
2. **Error Handling**: Implement robust error handling in service methods
3. **Resource Management**: Properly clean up resources in the `stop()` method
4. **Configuration**: Use the `config` property for service-specific settings
5. **Logging**: Use the runtime's logger for consistent logging

```typescript
export class BestPracticeService extends Service {
  private resources: any[] = [];

  static async start(runtime: IAgentRuntime): Promise<BestPracticeService> {
    try {
      const service = new BestPracticeService(runtime);
      await service.initialize();
      runtime.logger.info('BestPracticeService started successfully');
      return service;
    } catch (error) {
      runtime.logger.error('Failed to start BestPracticeService:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Clean up all resources
    for (const resource of this.resources) {
      try {
        await resource.cleanup();
      } catch (error) {
        this.runtime.logger.error('Error cleaning up resource:', error);
      }
    }
    this.resources = [];
  }
}
```

## Service vs Plugin

Understanding the distinction:

- **Plugins**: Provide actions, evaluators, providers, and services
- **Services**: Long-running processes that maintain state and connections

Services are one component that plugins can provide, alongside actions and other capabilities.

## FAQ

### How do services differ from actions?

Actions are discrete operations triggered by the agent's decision-making, while services are long-running processes that provide continuous functionality.

### Can services communicate with each other?

Yes, services can access other services through the runtime and coordinate activities, though direct dependencies should be avoided.

### What happens if a service fails to start?

If a service fails during initialization, the error is logged but doesn't prevent the agent from starting. The service simply won't be available.

### How are service configurations managed?

Service configurations can be provided through:

- Plugin configuration
- Runtime settings via `runtime.getSetting()`
- Environment variables
- Character configuration

### Can I register services dynamically?

Services are typically registered during plugin initialization, but the runtime supports dynamic registration for services that need to be added after initialization.

---

## Supported Services

| Service                                                                            | Type          | Key Features                                                                           | Use Cases                                                            |
| ---------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Discord](https://github.com/elizaos-plugins/plugin-discord)                       | Communication | • Voice channels • Server management • Moderation tools • Channel management           | • Community management • Gaming servers • Event coordination         |
| [Twitter](https://github.com/elizaos-plugins/plugin-twitter)                       | Social Media  | • Post scheduling • Timeline monitoring • Engagement analytics • Content automation    | • Brand management • Content creation • Social engagement            |
| [Telegram](https://github.com/elizaos-plugins/plugin-telegram)                     | Messaging     | • Bot API • Group chat • Media handling • Command system                               | • Customer support • Community engagement • Broadcast messaging      |
| [Direct](https://github.com/elizaOS/eliza/tree/develop/packages/plugin-direct/src) | API           | • REST endpoints • Web integration • Custom applications • Real-time communication     | • Backend integration • Web apps • Custom interfaces                 |
| [GitHub](https://github.com/elizaos-plugins/plugin-github)                         | Development   | • Repository management • Issue tracking • Pull requests • Code review                 | • Development workflow • Project management • Team collaboration     |
| [Slack](https://github.com/elizaos-plugins/plugin-slack)                           | Enterprise    | • Channel management • Conversation analysis • Workspace tools • Integration hooks     | • Team collaboration • Process automation • Internal tools           |
| [Lens](https://github.com/elizaos-plugins/plugin-lens)                             | Web3          | • Decentralized networking • Content publishing • Memory management • Web3 integration | • Web3 social networking • Content distribution • Decentralized apps |
| [Farcaster](https://github.com/elizaos-plugins/plugin-farcaster)                   | Web3          | • Decentralized social • Content publishing • Community engagement                     | • Web3 communities • Content creation • Social networking            |
| [Auto](https://github.com/elizaos-plugins/plugin-auto)                             | Automation    | • Workload management • Task scheduling • Process automation                           | • Background jobs • Automated tasks • System maintenance             |

**\*Additional services**:

- Instagram: Social media content and engagement
- XMTP: Web3 messaging and communications
- Alexa: Voice interface and smart device control
- Home Assistant: Home automation OS
- Devai.me: AI first social service
- Simsai: Jeeter / Social media platform for AI

---

## System Overview

Services serve as bridges between Eliza agents and various platforms, providing core capabilities:

1. **Message Processing**

   - Platform-specific message formatting and delivery
   - Media handling and attachments via [`Memory`](/api/interfaces/Memory) objects
   - Reply threading and context management
   - Support for different content types

2. **State & Memory Management**

   - Each service maintains independent state to prevent cross-platform contamination
   - Integrates with runtime memory managers for different types of content:
   - Messages processed by one service don't automatically appear in other services' contexts
   - [`State`](/api/interfaces/State) persists across agent restarts through the database adapter

3. **Platform Integration**
   - Authentication and API compliance
   - Event processing and webhooks
   - Rate limiting and cache management
   - Platform-specific feature support

## Service Configuration

Services are configured through the [`Character`](/api/type-aliases/Character) configuration's `settings` property:

```typescript
export type Character = {
  // ... other properties ...
  settings?: {
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
    // ... other service configs
  };
};
```

## Service Implementation

Each service manages its own:

- Platform-specific message formatting and delivery
- Event processing and webhooks
- Authentication and API integration
- Message queueing and rate limiting
- Media handling and attachments
- State management and persistence

Example of a basic service implementation:

```typescript
import { Service, IAgentRuntime } from '@elizaos/core';

export class CustomService extends Service {
  static serviceType = 'custom';
  capabilityDescription = 'The agent is able to interact with the custom platform';

  constructor(protected runtime: IAgentRuntime) {
    super();
    // Initialize platform connection
    // Set up event handlers
    // Configure message processing
  }

  static async start(runtime: IAgentRuntime): Promise<CustomService> {
    const service = new CustomService(runtime);
    // Additional initialization if needed
    return service;
  }

  async stop(): Promise<void> {
    // Cleanup resources
    // Close connections
  }
}
```

### Runtime Integration

Services interact with the agent runtime through the [`IAgentRuntime`](api/interfaces/IAgentRuntime/) interface, which provides:

- Memory managers for different types of data storage
- Service access for capabilities like transcription or image generation
- State management and composition
- Message processing and action handling

### Memory System Integration

Services use the runtime's memory managers to persist conversation data (source: [`memory.ts`](/api/interfaces/Memory)).

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

## FAQ

### What can services actually do?

Services handle platform-specific communication (like Discord messages or Twitter posts), manage memories and state, and execute actions like processing media or handling commands. Each service adapts these capabilities to its platform while maintaining consistent agent behavior.

### Can multiple services be used simultaneously?
Yes, Eliza supports running multiple services concurrently while maintaining consistent agent behavior across platforms.

### How are service-specific features handled?
Each service implements platform-specific features through its capabilities system, while maintaining a consistent interface for the agent.

### How do services handle rate limits?
Services implement platform-specific rate limiting with backoff strategies and queue management.

### How is service state managed?
Services maintain their own connection state while integrating with the agent's runtime database adapter and memory / state management system.

### How do services handle messages?

Services translate platform messages into Eliza's internal format, process any attachments (images, audio, etc.), maintain conversation context, and manage response queuing and rate limits.

### How are messages processed across services?
Each service processes messages independently in its platform-specific format, while maintaining conversation context through the shared memory system. V2 improves upon this architecture.

### How is state managed between services?
Each service maintains separate state to prevent cross-contamination, but can access shared agent state through the runtime.


### How do services integrate with platforms?

Each service implements platform-specific authentication, API compliance, webhook handling, and follows the platform's rules for rate limiting and content formatting.

### How do services manage memory?

Services use Eliza's memory system to track conversations, user relationships, and state, enabling context-aware responses and persistent interactions across sessions.
```
