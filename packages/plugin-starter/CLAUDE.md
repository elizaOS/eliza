# ElizaOS Plugin Development Guide for Claude

> **Optimized for Claude LLM** - Complete reference for building ElizaOS plugins

## 📋 Project Overview

| Property            | Value                 |
| ------------------- | --------------------- |
| **Project Type**    | ElizaOS Plugin        |
| **Package Manager** | `bun` (REQUIRED)      |
| **Language**        | TypeScript (Required) |
| **Testing**         | Bun test              |
| **Runtime**         | ElizaOS Agent Runtime |

## 🏗️ Plugin Architecture

ElizaOS plugins follow a **component-based architecture** with four main types:

### 🔄 **Services** (Required for External APIs)

**Purpose:** Handle stateful operations and external integrations

```typescript
export class ExampleService extends Service {
  static serviceType = 'example';
  private apiClient: ExternalAPI;

  constructor() {
    super();
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Initialize SDK connections, databases, etc.
    this.apiClient = new ExternalAPI(process.env.API_KEY);
  }

  async processData(data: any): Promise<any> {
    // Your business logic here
    return await this.apiClient.process(data);
  }
}
```

**Services are for:**

- ✅ API connections and SDK management
- ✅ Database operations
- ✅ State management
- ✅ Authentication handling
- ❌ NOT for simple data formatting (use Providers)

### ⚡ **Actions** (Required for User Interactions)

**Purpose:** Handle user commands and generate responses

```typescript
import { Action, ActionResult } from '@elizaos/core';

export const exampleAction: Action = {
  name: 'EXAMPLE_ACTION',
  description: 'Processes user requests for example functionality',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('example') || text.includes('demo');
  },

  handler: async (runtime, message, state, options, callback): Promise<ActionResult> => {
    try {
      const service = runtime.getService<ExampleService>('example');
      const result = await service.processData(message.content);

      await callback({
        text: `Here's your result: ${result}`,
        action: 'EXAMPLE_ACTION',
      });

      return {
        success: true,
        text: `Successfully processed: ${result}`,
        values: {
          lastProcessed: result,
          processedAt: Date.now(),
        },
        data: {
          actionName: 'EXAMPLE_ACTION',
          result,
        },
      };
    } catch (error) {
      await callback({
        text: 'I encountered an error processing your request.',
        error: true,
      });

      return {
        success: false,
        text: 'Failed to process request',
        error: error instanceof Error ? error : new Error(String(error)),
        data: {
          actionName: 'EXAMPLE_ACTION',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};
```

**Actions handle:**

- ✅ User input validation
- ✅ Command parsing and routing
- ✅ Service coordination
- ✅ Response generation
- ❌ NOT direct API calls (use Services)

**Important: Callbacks vs ActionResult:**

- **`callback()`** → Sends messages to the user in chat
- **`ActionResult` return** → Passes data/state to next action in chain
- Both are used together: callback for user communication, return for action chaining

### 📊 **Providers** (Optional - Context Supply)

**Purpose:** Supply read-only contextual information

```typescript
export const exampleProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const service = runtime.getService<ExampleService>('example');
    const status = await service.getStatus();

    return `Current system status: ${status.state}
Available features: ${status.features.join(', ')}
Last updated: ${status.timestamp}`;
  },
};
```

**Providers supply:**

- ✅ Formatted contextual data
- ✅ Real-time information
- ✅ System state summaries
- ❌ NOT for state modification

### 🧠 **Evaluators** (Optional - Post-Processing)

**Purpose:** Learn from interactions and analyze outcomes

```typescript
export const exampleEvaluator: Evaluator = {
  name: 'EXAMPLE_EVALUATOR',

  evaluate: async (runtime: IAgentRuntime, message: Memory, state?: any) => {
    // Analyze the interaction outcome
    const success = state?.lastActionSuccess || false;

    if (success) {
      // Store successful patterns
      await runtime.addMemory({
        content: { text: 'Successful example interaction pattern' },
        type: 'learning',
      });
    }

    return { success, confidence: 0.8 };
  },
};
```

## 📁 Project Structure

```
src/
├── 📂 actions/           # User command handlers
│   ├── exampleAction.ts
│   └── index.ts
├── 📂 services/          # External integrations (REQUIRED)
│   ├── ExampleService.ts
│   └── index.ts
├── 📂 providers/         # Context suppliers (optional)
│   ├── exampleProvider.ts
│   └── index.ts
├── 📂 evaluators/        # Learning components (optional)
│   ├── exampleEvaluator.ts
│   └── index.ts
├── 📂 types/            # TypeScript definitions
│   └── index.ts
├── 📄 index.ts          # Plugin export
└── 📄 package.json      # Dependencies and metadata
```

## 📦 Plugin Export Pattern

```typescript
// src/index.ts
import { Plugin } from '@elizaos/core';
import { ExampleService } from './services';
import { exampleAction } from './actions';
import { exampleProvider } from './providers';
import { exampleEvaluator } from './evaluators';

export const plugin: Plugin = {
  name: 'example-plugin',
  description: 'Demonstrates ElizaOS plugin patterns',

  // Core components
  services: [ExampleService],
  actions: [exampleAction],

  // Optional components
  providers: [exampleProvider],
  evaluators: [exampleEvaluator],
};

export default plugin;

// Re-export components for external use
export { ExampleService } from './services';
export * from './types';
```

## 🚀 Development Workflow

### Quick Start Commands

```bash
# Install dependencies
bun install

# Start development with hot reload
elizaos dev

# Run tests
bun test

# Build for production
bun run build
```

### 🧪 Testing Your Plugin

#### **Method 1: Dev Mode (Recommended)**

```bash
elizaos dev
```

This automatically:

- Loads your plugin from current directory
- Creates a test character with your plugin
- Starts interactive chat interface
- Enables hot reloading

#### **Method 2: Unit Testing**

```typescript
// tests/actions.test.ts
import { describe, it, expect } from 'bun:test';
import { exampleAction } from '../src/actions';

describe('ExampleAction', () => {
  it('validates trigger words correctly', async () => {
    const mockMessage = {
      content: { text: 'show me an example' },
    };

    const isValid = await exampleAction.validate(mockRuntime, mockMessage);

    expect(isValid).toBe(true);
  });
});
```

## 🎯 Best Practices

### ✅ **DO**

- **Use Services for APIs**: All external calls go through services
- **Validate User Input**: Always validate in action handlers
- **Handle Errors Gracefully**: Provide meaningful error messages
- **Follow TypeScript**: Use strict typing throughout
- **Test Thoroughly**: Write tests for core functionality

### ❌ **DON'T**

- **API Calls in Actions**: Use services instead
- **State in Providers**: Keep providers read-only
- **Parse Input in Evaluators**: Use actions for input handling
- **Hardcode Credentials**: Use environment variables
- **Skip Error Handling**: Always handle potential failures

### 🔧 **Common Patterns**

#### Error Handling Pattern

```typescript
export const robustAction: Action = {
  name: 'ROBUST_ACTION',
  description: 'Demonstrates robust error handling',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Validate user input before processing
    const text = message.content.text.toLowerCase();
    return text.includes('process') || text.includes('execute');
  },

  handler: async (runtime, message, state, options, callback): Promise<ActionResult> => {
    try {
      const service = runtime.getService<YourService>('yourService');
      if (!service) {
        throw new Error('Service not available');
      }

      const result = await service.performOperation();

      await callback({
        text: `Operation completed: ${result}`,
        action: 'ROBUST_ACTION',
      });

      return {
        success: true,
        text: `Successfully completed operation`,
        values: {
          operationResult: result,
          processedAt: Date.now(),
        },
        data: {
          actionName: 'ROBUST_ACTION',
          result,
        },
      };
    } catch (error) {
      console.error(`Action failed: ${error instanceof Error ? error.message : String(error)}`);

      await callback({
        text: "I'm sorry, I couldn't complete that request. Please try again.",
        error: true,
      });

      return {
        success: false,
        text: 'Failed to complete operation',
        error: error instanceof Error ? error : new Error(String(error)),
        data: {
          actionName: 'ROBUST_ACTION',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
```

#### Service Initialization Pattern

```typescript
export class RobustService extends Service {
  private client: ExternalClient;
  private isInitialized = false;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    try {
      this.client = new ExternalClient({
        apiKey: process.env.EXTERNAL_API_KEY,
        timeout: 30000,
      });

      await this.client.authenticate();
      this.isInitialized = true;

      console.log('Service initialized successfully');
    } catch (error) {
      console.error('Service initialization failed:', error);
      throw error;
    }
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Service not initialized');
    }
  }

  async performOperation(): Promise<any> {
    this.ensureInitialized();
    return await this.client.operation();
  }
}
```

## 🐛 Debugging Guide

### Environment Variables

```bash
# Enable detailed logging
LOG_LEVEL=debug elizaos dev

# Test specific components
elizaos test --filter "action-name"
```

### Common Issues & Solutions

| Issue                   | Cause                          | Solution                     |
| ----------------------- | ------------------------------ | ---------------------------- |
| "Service not found"     | Service not registered         | Add to plugin services array |
| "Action not triggering" | Validation function too strict | Check validate() logic       |
| "Provider not updating" | Provider has state             | Make provider stateless      |
| "Memory errors"         | Database connection issues     | Check database adapter setup |

## 📋 Package.json Template

```json
{
  "name": "@your-org/elizaos-plugin-example",
  "version": "1.0.0",
  "description": "ElizaOS plugin for example functionality",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],

  "scripts": {
    "build": "bun run build:types && bun run build:js",
    "build:types": "tsc",
    "build:js": "bun build src/index.ts --outdir dist",
    "test": "bun test",
    "dev": "elizaos dev"
  },

  "peerDependencies": {
    "@elizaos/core": "*"
  },

  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  },

  "keywords": ["elizaos", "plugin", "ai-agent"]
}
```

## 🎯 Final Checklist

Before publishing your plugin:

- [ ] All services have proper initialization
- [ ] Actions validate user input correctly
- [ ] Error handling covers edge cases
- [ ] Tests pass for core functionality
- [ ] TypeScript compiles without errors
- [ ] Plugin exports are correct
- [ ] Documentation is complete
- [ ] Environment variables are documented

---

**🎉 Ready to build your ElizaOS plugin!** Start with the dev mode and iterate based on real testing.
