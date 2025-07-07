---
title: Creating Plugins
description: Step-by-step guide to creating ElizaOS plugins using the CLI tool
---

This guide shows you how to use the ElizaOS CLI to quickly create, test, and publish plugins. Plugins are the primary way to extend ElizaOS functionality by adding new actions, providers, evaluators, services, and more to your agents.

## Quick Start

The fastest way to create a new plugin is using the ElizaOS CLI:

```bash
# Create a new plugin (automatically adds "plugin-" prefix)
elizaos create my-awesome-feature -t plugin

# Navigate to your new plugin
cd plugin-my-awesome-feature

# Start development
elizaos dev
```

This creates a fully functional plugin with example implementations and tests.

## Plugin Structure

A typical plugin follows this directory structure:

```text
plugin-name/
├── src/
│   ├── index.ts          # Main plugin export
│   ├── actions/          # Action handlers
│   │   └── myAction.ts
│   ├── providers/        # Context providers
│   │   └── myProvider.ts
│   ├── evaluators/       # Message evaluators
│   │   └── myEvaluator.ts
│   ├── services/         # Background services
│   │   └── myService.ts
│   └── __tests__/        # Tests
│       └── actions.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── images/               # Required for publishing
    ├── logo.jpg         # 400x400px square (max 500KB)
    └── banner.jpg       # 1280x640px banner (max 1MB)
```

## Core Components

### Plugin Definition

Every plugin must export a default object implementing the `Plugin` interface:

```typescript
// src/index.ts
import { Plugin } from '@elizaos/core';
import { myAction } from './actions/myAction';
import { myProvider } from './providers/myProvider';
import { myEvaluator } from './evaluators/myEvaluator';
import { MyService } from './services/myService';

export default {
  name: 'my-plugin',
  description: 'Adds awesome functionality to ElizaOS',

  // Optional initialization
  init: async (config, runtime) => {
    console.log('Plugin initializing with config:', config);
    // Perform any setup needed
  },

  // Register components
  actions: [myAction],
  providers: [myProvider],
  evaluators: [myEvaluator],
  services: [MyService], // Note: Services are class constructors

  // Optional configuration schema
  config: {
    apiKey: {
      type: 'string',
      description: 'API key for external service',
      required: true,
    },
  },
} satisfies Plugin;
```

### Actions

Actions define how your plugin responds to user messages:

```typescript
// src/actions/myAction.ts
import { Action, IAgentRuntime, State, Memory } from '@elizaos/core';

export const myAction: Action = {
  name: 'MY_AWESOME_ACTION',
  similes: ['AWESOME_ACTION', 'DO_AWESOME'], // Alternative names
  description: 'Performs an awesome action',

  // Validate if this action should handle the message
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const text = message.content.text.toLowerCase();
    return text.includes('do something awesome');
  },

  // Handle the action
  handler: async (runtime, message, state, options, callback) => {
    try {
      // Perform your action logic
      const result = await performAwesomeTask(message.content.text);

      // Generate response
      const response = {
        text: `I did something awesome: ${result}`,
        action: 'MY_AWESOME_ACTION',
        data: { result },
      };

      // Call callback if provided
      if (callback) {
        await callback(response);
      }

      return response;
    } catch (error) {
      console.error('Action failed:', error);
      return {
        text: 'Sorry, I encountered an error.',
        error: error.message,
      };
    }
  },

  // Provide examples for the AI
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Can you do something awesome?' },
      },
      {
        user: '{{agent}}',
        content: {
          text: "I'll do something awesome for you!",
          action: 'MY_AWESOME_ACTION',
        },
      },
    ],
  ],
};
```

### Providers

Providers supply dynamic context to the agent:

```typescript
// src/providers/myProvider.ts
import { Provider, IAgentRuntime, State, Memory } from '@elizaos/core';

export const myProvider: Provider = {
  name: 'MY_DATA_PROVIDER',
  description: 'Provides awesome contextual data',

  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    try {
      // Fetch or compute relevant data
      const data = await fetchRelevantData(message.userId);

      return {
        text: `User data: ${JSON.stringify(data)}`,
        values: {
          userData: data,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      console.error('Provider error:', error);
      return { text: 'Unable to fetch data' };
    }
  },
};
```

### Evaluators

Evaluators analyze messages and can influence agent behavior:

```typescript
// src/evaluators/myEvaluator.ts
import { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';

export const myEvaluator: Evaluator = {
  name: 'SENTIMENT_EVALUATOR',
  description: 'Analyzes message sentiment',

  // Only evaluate messages that meet criteria
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text.length > 10;
  },

  // Perform evaluation
  handler: async (runtime, message) => {
    const sentiment = analyzeSentiment(message.content.text);

    // Store evaluation result
    await runtime.createMemory({
      ...message,
      content: {
        ...message.content,
        evaluations: {
          sentiment: sentiment,
        },
      },
    });

    return sentiment;
  },
};
```

### Services

Services provide shared functionality and background tasks:

```typescript
// src/services/myService.ts
import { Service, IAgentRuntime } from '@elizaos/core';

export class MyService extends Service {
  static serviceType = 'my-awesome-service';
  capabilityDescription = 'Provides awesome background functionality';

  private interval: NodeJS.Timer | null = null;

  // Factory method to create service
  static async start(runtime: IAgentRuntime): Promise<MyService> {
    const service = new MyService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    // Set up background tasks
    this.interval = setInterval(() => {
      this.performBackgroundTask();
    }, 60000); // Every minute
  }

  async stop(): Promise<void> {
    // Clean up resources
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async performBackgroundTask(): Promise<void> {
    // Do something in the background
    console.log('Performing background task...');
  }

  // Public methods for other components to use
  async getData(key: string): Promise<any> {
    // Return data from service
    return this.cache.get(key);
  }
}
```

## Configuration

### package.json

Your plugin's `package.json` must include specific metadata:

```json
{
  "name": "@yourorg/plugin-awesome",
  "version": "1.0.0",
  "description": "Adds awesome functionality to ElizaOS",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "packageType": "plugin",
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "API_KEY": {
        "type": "string",
        "description": "API key for the awesome service",
        "required": true
      },
      "WEBHOOK_URL": {
        "type": "string",
        "description": "Webhook URL for notifications",
        "required": false
      }
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run"
  },
  "peerDependencies": {
    "@elizaos/core": "^1.0.0"
  },
  "devDependencies": {
    "@elizaos/core": "^1.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

### TypeScript Configuration

Use a standard TypeScript configuration:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

## Testing

ElizaOS provides comprehensive testing capabilities:

### Unit Tests

Test individual components:

```typescript
// src/__tests__/actions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { myAction } from '../actions/myAction';
import { createMockRuntime } from '@elizaos/core/test-utils';

describe('myAction', () => {
  it('should validate messages containing trigger phrase', async () => {
    const runtime = createMockRuntime();
    const message = {
      content: { text: 'Please do something awesome' },
      userId: 'test-user',
      roomId: 'test-room',
      agentId: 'test-agent',
    };

    const isValid = await myAction.validate(runtime, message);
    expect(isValid).toBe(true);
  });

  it('should handle action successfully', async () => {
    const runtime = createMockRuntime();
    const message = {
      content: { text: 'Do something awesome now!' },
      userId: 'test-user',
      roomId: 'test-room',
      agentId: 'test-agent',
    };

    const callback = vi.fn();
    const result = await myAction.handler(runtime, message, {}, {}, callback);

    expect(result.text).toContain('awesome');
    expect(callback).toHaveBeenCalled();
  });
});
```

### End-to-End Tests

Test the plugin in a real agent environment:

```typescript
// src/__tests__/e2e.test.ts
import { TestSuite } from '@elizaos/core';

export const e2eTestSuite: TestSuite = {
  name: 'plugin_e2e_tests',
  description: 'End-to-end tests for the awesome plugin',
  tests: [
    {
      name: 'complete_workflow_test',
      description: 'Tests the complete plugin workflow',
      fn: async (runtime) => {
        // Send a message that triggers the action
        const response = await runtime.processMessage({
          content: { text: 'Do something awesome please' },
          userId: 'e2e-test-user',
          roomId: 'e2e-test-room',
        });

        // Verify the response
        if (!response.includes('awesome')) {
          throw new Error('Expected awesome response');
        }

        // Verify service is running
        const service = runtime.getService('my-awesome-service');
        if (!service) {
          throw new Error('Service not initialized');
        }
      },
    },
  ],
};

// Add to plugin definition
export default {
  // ... other plugin config
  tests: [e2eTestSuite],
};
```

### Running Tests

```bash
# Run unit tests
npm test

# Run with elizaos test command (includes E2E)
elizaos test

# Run specific test type
elizaos test -t component  # Unit tests only
elizaos test -t e2e        # E2E tests only
```

## Publishing

### Prerequisites

1. **npm account**: Create at [npmjs.com](https://www.npmjs.com)
2. **GitHub repository**: Create a public repo
3. **Required images**:
   - `images/logo.jpg` - 400x400px square logo (max 500KB)
   - `images/banner.jpg` - 1280x640px banner image (max 1MB)

### Publishing Steps

1. **Authenticate with npm**:

   ```bash
   npm login
   ```

2. **Add GitHub topic**:

   - Go to your GitHub repository
   - Add the topic `elizaos-plugins`

3. **Test your plugin**:

   ```bash
   # Run all tests
   npm test

   # Test the publish process
   elizaos publish --test
   ```

4. **Publish**:

   ```bash
   # First time publishing
   elizaos publish

   # Updates (after initial publish)
   npm version patch
   npm publish
   git push origin main --tags
   ```

### Post-Publishing

Your plugin will appear in:

- npm registry: `https://www.npmjs.com/package/@yourorg/plugin-name`
- ElizaOS Plugin Directory: Automatically indexed from GitHub
- Agent configurations can reference it: `"plugins": ["@yourorg/plugin-name"]`

## Best Practices

### Code Quality

1. **Complete implementations**: Never use stubs or incomplete code
2. **Error handling**: Always handle errors gracefully
3. **Resource cleanup**: Implement proper cleanup in services
4. **Type safety**: Use TypeScript strictly
5. **Documentation**: Document all exports and parameters

### Performance

1. **Cache expensive operations**: Use runtime caching
2. **Async operations**: Don't block the event loop
3. **Batch operations**: Group related operations
4. **Lazy loading**: Load resources only when needed

### Security

1. **Validate inputs**: Always validate user inputs
2. **Sanitize outputs**: Prevent injection attacks
3. **Secure credentials**: Never hardcode secrets
4. **Rate limiting**: Implement rate limits for external APIs

### Testing

1. **High coverage**: Aim for >80% test coverage
2. **Edge cases**: Test error conditions and edge cases
3. **Integration tests**: Test with real agent runtime
4. **Performance tests**: Monitor resource usage

## Common Patterns

### Using Configuration

Access plugin configuration in your components:

```typescript
export const configuredAction: Action = {
  name: 'CONFIGURED_ACTION',

  handler: async (runtime, message, state, options) => {
    // Access plugin config
    const apiKey = runtime.getSetting('API_KEY');
    if (!apiKey) {
      throw new Error('API_KEY not configured');
    }

    // Use the configuration
    const result = await callExternalAPI(apiKey, message.content.text);
    return { text: result };
  },
};
```

### Sharing Data Between Components

Use services to share data:

```typescript
// In an action
const myService = runtime.getService('my-awesome-service') as MyService;
const cachedData = await myService.getData('user-preferences');

// In a provider
const myService = runtime.getService('my-awesome-service') as MyService;
return {
  text: 'User preferences loaded',
  values: await myService.getData('user-preferences'),
};
```

### Event Handling

React to agent events:

```typescript
export default {
  name: 'event-plugin',

  events: {
    onMessageReceived: async (runtime, message) => {
      console.log('Message received:', message);
    },

    onActionComplete: async (runtime, action, result) => {
      console.log('Action completed:', action, result);
    },
  },
} satisfies Plugin;
```

## Troubleshooting

### Common Issues

1. **Plugin not loading**:

   - Check `package.json` has correct `packageType: "plugin"`
   - Verify main export is default
   - Check for circular dependencies

2. **Actions not triggering**:

   - Verify `validate` returns true for test messages
   - Check action name is unique
   - Enable debug logging: `DEBUG=eliza:*`

3. **Service errors**:

   - Ensure `static serviceType` is defined
   - Implement `start()` factory method
   - Check service is in plugin's `services` array

4. **Publishing fails**:
   - Verify npm authentication
   - Check image sizes and formats
   - Ensure GitHub repo is public with correct topic

## Next Steps

- Explore the [Plugin API Reference](/api/interfaces/Plugin)
- Browse [example plugins](https://github.com/elizaos/eliza/tree/main/packages)
- Join the [ElizaOS Discord](https://discord.gg/elizaos) for help
- Contribute to the [plugin ecosystem](https://github.com/topics/elizaos-plugins)
