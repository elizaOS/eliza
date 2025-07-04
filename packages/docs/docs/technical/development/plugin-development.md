---
title: Plugin Development Guide
description: Comprehensive guide to developing plugins for ElizaOS
---

# Plugin Development Guide

This guide walks you through creating custom plugins for ElizaOS, from basic concepts to advanced patterns.

## Overview

ElizaOS plugins extend agent capabilities through a standardized interface. Plugins can add:

- **Actions**: New ways for agents to respond to user input
- **Providers**: Context and data sources for agent decision-making
- **Evaluators**: Message analysis and processing logic
- **Services**: Shared functionality and integrations

## Getting Started

### Prerequisites

- Node.js 23.3.0 or higher
- TypeScript knowledge
- Basic understanding of ElizaOS concepts

### Plugin Structure

A basic plugin follows this structure:

```
my-plugin/
├── src/
│   ├── index.ts          # Main plugin export
│   ├── actions/          # Action handlers
│   ├── providers/        # Context providers
│   ├── evaluators/       # Message evaluators
│   └── services/         # Background services
├── package.json
├── tsconfig.json
└── README.md
```

### Basic Plugin Template

```typescript
// src/index.ts
import { Plugin, IAgentRuntime } from '@elizaos/core';
import { myAction } from './actions/myAction';
import { myProvider } from './providers/myProvider';
import { myEvaluator } from './evaluators/myEvaluator';
import { MyService } from './services/myService';

const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom ElizaOS plugin',

  // Core components
  actions: [myAction],
  providers: [myProvider],
  evaluators: [myEvaluator],
  services: [MyService], // Service classes, not instances

  // Optional configuration
  config: {
    apiKey: 'your-api-key-here'
  },

  // Lifecycle hooks
  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    console.log('My plugin initialized!');
    // Initialize plugin resources
  }
};

export default myPlugin;
```

## Creating Actions

Actions define how your plugin responds to user messages.

### Action Structure

```typescript
// src/actions/myAction.ts
import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';

export const myAction: Action = {
  name: 'MY_ACTION',
  description: 'Performs a custom action',

  // Validation function - determines if this action should handle the message
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Return true if this action should handle the message
    return message.content.text.toLowerCase().includes('do something');
  },

  // Handler function - executes the action
  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Perform your action logic
    const result = await performCustomLogic(message);

    // Return response
    return {
      text: `Action completed: ${result}`,
      action: 'MY_ACTION',
    };
  },

  // Examples for training/testing
  examples: [
    [
      {
        user: '{{user}}',
        content: { text: 'Can you do something special?' },
      },
      {
        user: '{{agent}}',
        content: { text: "I'll do something special for you!", action: 'MY_ACTION' },
      },
    ],
  ],
};
```

### Advanced Action Features

```typescript
export const advancedAction: Action = {
  name: 'ADVANCED_ACTION',
  description: 'Demonstrates advanced action features',

  // Similarity threshold for matching
  similes: ['similar action', 'related command'],

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Access services
    const customService = runtime.getService('custom-service');

    // Check permissions
    const hasPermission = await customService.checkPermission(message.userId);

    // Complex validation logic
    return hasPermission && isValidCommand(message.content.text);
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Access character configuration
    const character = runtime.character;

    // Use providers for context
    const context = await runtime.getProvider('custom-context');

    // Access conversation state
    const previousMessages = await runtime.messageManager.getMemories({
      roomId: message.roomId,
      count: 10,
    });

    // Perform action with full context
    const response = await processWithContext(message, context, previousMessages);

    // Store action result in state
    if (state) {
      state.lastAction = {
        type: 'ADVANCED_ACTION',
        timestamp: Date.now(),
        result: response,
      };
    }

    return response;
  },
};
```

## Creating Providers

Providers supply dynamic context to agents.

### Basic Provider

```typescript
// src/providers/myProvider.ts
import { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';

export const myProvider: Provider = {
  get: async (runtime: IAgentRuntime, message?: Memory, state?: State) => {
    // Gather contextual information
    const data = await fetchRelevantData();

    // Format for agent consumption
    return `Current context: ${JSON.stringify(data)}`;
  },
};
```

### Advanced Provider with Caching

```typescript
export const cachedProvider: Provider = {
  get: async (runtime: IAgentRuntime, message?: Memory) => {
    const cacheKey = `provider-${message?.roomId || 'global'}`;
    const cacheService = runtime.getService('cache');

    // Check cache first
    const cached = await cacheService.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 60000) {
      // 1 minute TTL
      return cached.data;
    }

    // Fetch fresh data
    const freshData = await complexDataFetch();

    // Update cache
    await cacheService.set(cacheKey, {
      data: freshData,
      timestamp: Date.now(),
    });

    return freshData;
  },
};
```

## Creating Evaluators

Evaluators analyze messages and determine processing paths.

### Basic Evaluator

```typescript
// src/evaluators/myEvaluator.ts
import { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';

export const myEvaluator: Evaluator = {
  name: 'MY_EVALUATOR',

  // Validation - should this evaluator process the message?
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text.length > 10;
  },

  // Evaluation logic
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    // Analyze message
    const sentiment = await analyzeSentiment(message.content.text);
    const intent = await detectIntent(message.content.text);

    // Store evaluation results
    await runtime.messageManager.createMemory({
      ...message,
      content: {
        ...message.content,
        evaluations: {
          sentiment,
          intent,
          evaluator: 'MY_EVALUATOR',
        },
      },
    });

    // Return evaluation context
    return {
      sentiment,
      intent,
      shouldRespond: sentiment.score < -0.5 || intent.type === 'question',
    };
  },
};
```

### Chained Evaluators

```typescript
export const chainedEvaluator: Evaluator = {
  name: 'CHAINED_EVALUATOR',

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Run multiple evaluations in sequence
    const evaluations = [];

    // Sentiment analysis
    if (await shouldAnalyzeSentiment(message)) {
      const sentiment = await analyzeSentiment(message.content.text);
      evaluations.push({ type: 'sentiment', result: sentiment });
    }

    // Entity extraction
    if (await shouldExtractEntities(message)) {
      const entities = await extractEntities(message.content.text);
      evaluations.push({ type: 'entities', result: entities });
    }

    // Topic classification
    if (await shouldClassifyTopic(message)) {
      const topics = await classifyTopics(message.content.text);
      evaluations.push({ type: 'topics', result: topics });
    }

    // Aggregate results
    return {
      evaluations,
      summary: summarizeEvaluations(evaluations),
      recommendations: generateRecommendations(evaluations),
    };
  },
};
```

## Creating Services

Services provide shared functionality across your plugin.

### Basic Service

```typescript
// src/services/myService.ts
import { Service, IAgentRuntime } from '@elizaos/core';

export class MyService extends Service {
  static serviceType = 'my-service';
  capabilityDescription = 'Provides custom service functionality';
  
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }
  
  static async start(runtime: IAgentRuntime): Promise<MyService> {
    const service = new MyService(runtime);
    await service.initialize();
    return service;
  }
  
  async stop(): Promise<void> {
    // Cleanup resources
    await this.closeConnections();
  }
  
  private async initialize(): Promise<void> {
    // Initialize service resources
    await this.setupConnections();
  }
  
  // Service methods
  async performOperation(data: any): Promise<any> {
    // Service logic
    return this.processData(data);
  }
  
  private async setupConnections(): Promise<void> {
    // Setup logic
  }
  
  private async closeConnections(): Promise<void> {
    // Cleanup logic
  }
  
  private processData(data: any): any {
    // Data processing logic
    return data;
  }
}
```

### Advanced Service with State Management

```typescript
export class StatefulService extends Service {
  private state: Map<string, any> = new Map();
  private subscriptions: Map<string, Function[]> = new Map();

  // State management
  setState(key: string, value: any): void {
    const oldValue = this.state.get(key);
    this.state.set(key, value);

    // Notify subscribers
    this.notifySubscribers(key, value, oldValue);
  }

  getState(key: string): any {
    return this.state.get(key);
  }

  // Subscription management
  subscribe(key: string, callback: Function): () => void {
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, []);
    }

    this.subscriptions.get(key)!.push(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.subscriptions.get(key) || [];
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    };
  }

  private notifySubscribers(key: string, newValue: any, oldValue: any): void {
    const callbacks = this.subscriptions.get(key) || [];
    callbacks.forEach((callback) => {
      try {
        callback(newValue, oldValue);
      } catch (error) {
        console.error('Subscriber error:', error);
      }
    });
  }
}
```

## Plugin Configuration

### Configuration Schema

```typescript
// src/config.ts
export const configSchema = {
  type: 'object',
  properties: {
    apiKey: {
      type: 'string',
      description: 'API key for external service',
      required: true,
    },
    endpoint: {
      type: 'string',
      description: 'Service endpoint URL',
      default: 'https://api.example.com',
    },
    timeout: {
      type: 'number',
      description: 'Request timeout in milliseconds',
      default: 5000,
    },
    features: {
      type: 'object',
      properties: {
        enableCache: {
          type: 'boolean',
          default: true,
        },
        cacheSize: {
          type: 'number',
          default: 100,
        },
      },
    },
  },
};
```

### Using Configuration

```typescript
const myPlugin: Plugin = {
  name: 'my-plugin',

  async onLoad(runtime: IAgentRuntime) {
    // Get plugin configuration
    const config = runtime.getSetting('myPlugin');

    // Validate configuration
    if (!config?.apiKey) {
      throw new Error('API key is required for my-plugin');
    }

    // Initialize with config
    const service = new MyService(config);
    await service.initialize();

    // Register service
    runtime.registerService('my-service', service);
  },
};
```

## Testing Plugins

### Unit Testing

```typescript
// tests/myAction.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { createMockRuntime } from '@elizaos/testing';
import { myAction } from '../src/actions/myAction';

describe('myAction', () => {
  let runtime: any;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it('should validate correct messages', async () => {
    const message = {
      content: { text: 'Please do something special' },
      userId: 'test-user',
      roomId: 'test-room',
    };

    const isValid = await myAction.validate(runtime, message);
    expect(isValid).toBe(true);
  });

  it('should handle action correctly', async () => {
    const message = {
      content: { text: 'Do something now' },
      userId: 'test-user',
      roomId: 'test-room',
    };

    const result = await myAction.handler(runtime, message);
    expect(result.text).toContain('Action completed');
    expect(result.action).toBe('MY_ACTION');
  });
});
```

### Integration Testing

```typescript
// tests/integration.test.ts
import { describe, it, expect } from 'bun:test';
import { createTestAgent } from '@elizaos/testing';
import myPlugin from '../src';

describe('Plugin Integration', () => {
  it('should load and function correctly', async () => {
    // Create test agent with plugin
    const agent = await createTestAgent({
      plugins: [myPlugin],
      character: {
        name: 'TestAgent',
        plugins: ['my-plugin'],
      },
    });

    // Send test message
    const response = await agent.processMessage({
      content: { text: 'Do something special' },
      userId: 'test-user',
      roomId: 'test-room',
    });

    // Verify plugin handled the message
    expect(response.action).toBe('MY_ACTION');
    expect(response.text).toContain('Action completed');

    // Cleanup
    await agent.cleanup();
  });
});
```

## Publishing Plugins

### Package Configuration

```json
{
  "name": "@your-org/elizaos-plugin-custom",
  "version": "1.0.0",
  "description": "Custom plugin for ElizaOS",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "bun test",
    "prepare": "npm run build"
  },
  "keywords": ["elizaos", "plugin", "ai", "agent"],
  "peerDependencies": {
    "@elizaos/core": "^1.0.0"
  },
  "devDependencies": {
    "@elizaos/core": "^1.0.0",
    "@elizaos/testing": "^1.0.0",
    "typescript": "^5.0.0"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": {
    "access": "public"
  }
}
```

### Publishing Steps

1. **Build your plugin**:

   ```bash
   npm run build
   npm run test
   ```

2. **Publish to npm**:

   ```bash
   npm publish
   ```

3. **Document usage**:

   ````markdown
   # Installation

   npm install @your-org/elizaos-plugin-custom

   # Usage

   Add to your character configuration:

   ```json
   {
     "plugins": ["@your-org/elizaos-plugin-custom"]
   }
   ```
   ````

   ```

   ```

## Best Practices

### 1. Error Handling

Always handle errors gracefully:

```typescript
export const robustAction: Action = {
  handler: async (runtime, message) => {
    try {
      const result = await riskyOperation();
      return { text: `Success: ${result}` };
    } catch (error) {
      runtime.logger.error('Action failed', { error, message });

      // Graceful fallback
      return {
        text: 'I encountered an issue processing that request. Please try again.',
        error: true,
      };
    }
  },
};
```

### 2. Resource Management

Clean up resources properly:

```typescript
const myPlugin: Plugin = {
  onLoad: async (runtime) => {
    // Initialize resources
    const connection = await createConnection();
    runtime.registerService('connection', connection);
  },

  onUnload: async (runtime) => {
    // Cleanup resources
    const connection = runtime.getService('connection');
    await connection?.close();
  },
};
```

### 3. Performance Optimization

Cache expensive operations:

```typescript
const cachedAction: Action = {
  handler: async (runtime, message) => {
    const cacheKey = `result-${message.content.text}`;

    // Check cache
    const cached = await runtime.cacheGet(cacheKey);
    if (cached) {
      return cached;
    }

    // Compute result
    const result = await expensiveOperation(message);

    // Cache for 5 minutes
    await runtime.cacheSet(cacheKey, result, 300);

    return result;
  },
};
```

### 4. Documentation

Document your plugin thoroughly:

````typescript
/**
 * Weather Plugin for ElizaOS
 *
 * Provides weather information and forecasts
 *
 * @example
 * ```json
 * {
 *   "plugins": ["@elizaos/plugin-weather"],
 *   "settings": {
 *     "weather": {
 *       "apiKey": "your-api-key"
 *     }
 *   }
 * }
 * ```
 */
export default weatherPlugin;
````

## Advanced Topics

### Plugin Composition

Combine multiple plugins:

```typescript
import { composePlugins } from '@elizaos/core';
import weatherPlugin from './weather';
import newsPlugin from './news';

export default composePlugins(weatherPlugin, newsPlugin);
```

### Dynamic Plugin Loading

Load plugins at runtime:

```typescript
async function loadDynamicPlugin(pluginPath: string): Promise<Plugin> {
  const module = await import(pluginPath);
  return module.default;
}
```

### Plugin Communication

Plugins can communicate via services:

```typescript
// Plugin A
const pluginA: Plugin = {
  onLoad: async (runtime) => {
    runtime.registerService('plugin-a-service', {
      getData: () => 'data from plugin A',
    });
  },
};

// Plugin B
const pluginB: Plugin = {
  actions: [
    {
      handler: async (runtime, message) => {
        const serviceA = runtime.getService('plugin-a-service');
        const data = serviceA?.getData();
        return { text: `Got: ${data}` };
      },
    },
  ],
};
```

## Troubleshooting

### Common Issues

1. **Plugin not loading**: Check that the plugin is properly exported and listed in character configuration
2. **Actions not triggering**: Verify validation logic and action names
3. **Service errors**: Ensure services are initialized before use
4. **Memory leaks**: Clean up event listeners and timers in onUnload

### Debug Mode

Enable debug logging:

```typescript
const debugPlugin: Plugin = {
  onLoad: async (runtime) => {
    if (runtime.getSetting('debug')) {
      runtime.logger.level = 'debug';
      runtime.logger.debug('Plugin loaded in debug mode');
    }
  },
};
```

## Resources

- [Plugin System Architecture](../architecture/plugin-system.md)
- [Core API Reference](../api-reference/core-api.md)
- [Example Plugins](https://github.com/elizaos/eliza/tree/main/packages)
- [Community Plugins](https://github.com/elizaos/community-plugins)

## Next Steps

1. Start with the basic template
2. Add actions for user interactions
3. Create providers for context
4. Build services for shared functionality
5. Test thoroughly
6. Publish and share with the community
