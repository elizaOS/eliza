---
title: Best Practices
description: Best practices for developing with ElizaOS
---

# Best Practices

This guide covers best practices for developing robust, scalable, and maintainable ElizaOS applications.

## Architecture Best Practices

### 1. Component Design

**✅ DO: Keep Components Small and Focused**

```typescript
// Good: Single responsibility
export const greetingAction: Action = {
  name: 'GREETING',
  handler: async ({ runtime, message }) => {
    const greeting = generateGreeting(message.content);
    return { text: greeting };
  },
};
```

**❌ DON'T: Create Monolithic Components**

```typescript
// Bad: Multiple responsibilities
export const everythingAction: Action = {
  name: 'DO_EVERYTHING',
  handler: async ({ runtime, message }) => {
    // Handle greetings, commands, database, API calls...
    // Too many responsibilities!
  },
};
```

### 2. State Management

**✅ DO: Use Immutable State Updates**

```typescript
// Good: Immutable update
const updateState = (state: State, update: Partial<State>): State => {
  return { ...state, ...update };
};
```

**❌ DON'T: Mutate State Directly**

```typescript
// Bad: Direct mutation
const updateState = (state: State, update: Partial<State>): State => {
  Object.assign(state, update); // Mutates original!
  return state;
};
```

### 3. Error Handling

**✅ DO: Implement Comprehensive Error Handling**

```typescript
export const robustAction: Action = {
  handler: async ({ runtime, message }) => {
    try {
      const result = await riskyOperation();
      return { success: true, data: result };
    } catch (error) {
      runtime.logger.error('Operation failed', { error, message });

      // Graceful fallback
      return {
        success: false,
        error: 'Operation temporarily unavailable',
      };
    }
  },
};
```

**❌ DON'T: Let Errors Propagate Unhandled**

```typescript
// Bad: No error handling
export const fragileAction: Action = {
  handler: async ({ runtime, message }) => {
    const result = await riskyOperation(); // Could crash!
    return result;
  },
};
```

## Plugin Development Best Practices

### 1. Plugin Structure

```typescript
// Good plugin structure
export const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',

  // Clear dependencies
  dependencies: ['core', 'memory'],

  // Lifecycle hooks
  async onLoad(runtime: IAgentRuntime) {
    // Initialize plugin resources
  },

  async onUnload(runtime: IAgentRuntime) {
    // Clean up resources
  },

  // Modular components
  actions: [action1, action2],
  providers: [provider1],
  evaluators: [evaluator1],
};
```

### 2. Resource Management

**✅ DO: Clean Up Resources**

```typescript
export class ConnectionManager {
  private connections: Map<string, Connection> = new Map();

  async connect(id: string): Promise<Connection> {
    const conn = await createConnection();
    this.connections.set(id, conn);
    return conn;
  }

  async cleanup(): Promise<void> {
    // Clean up all connections
    for (const [id, conn] of this.connections) {
      await conn.close();
    }
    this.connections.clear();
  }
}
```

### 3. Configuration Validation

**✅ DO: Validate Configuration**

```typescript
export function validateConfig(config: unknown): PluginConfig {
  const schema = z.object({
    apiKey: z.string().min(1),
    endpoint: z.string().url(),
    timeout: z.number().positive().default(5000),
    retries: z.number().int().min(0).default(3),
  });

  return schema.parse(config);
}
```

## Performance Best Practices

### 1. Memory Management

**✅ DO: Implement Memory Limits**

```typescript
export class MemoryManager {
  private readonly MAX_MEMORIES = 1000;
  private memories: Memory[] = [];

  addMemory(memory: Memory): void {
    this.memories.push(memory);

    // Prune old memories if limit exceeded
    if (this.memories.length > this.MAX_MEMORIES) {
      this.memories = this.memories
        .sort((a, b) => b.importance - a.importance)
        .slice(0, this.MAX_MEMORIES);
    }
  }
}
```

### 2. Caching Strategies

**✅ DO: Cache Expensive Operations**

```typescript
export class CachedProvider implements Provider {
  private cache = new Map<string, CacheEntry>();
  private readonly TTL = 5 * 60 * 1000; // 5 minutes

  async get(key: string): Promise<any> {
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.TTL) {
      return cached.value;
    }

    const value = await this.fetchData(key);
    this.cache.set(key, { value, timestamp: Date.now() });
    return value;
  }
}
```

### 3. Async Operations

**✅ DO: Use Concurrent Processing**

```typescript
// Good: Parallel processing
export async function processMessages(messages: Message[]): Promise<Result[]> {
  return Promise.all(messages.map((msg) => processMessage(msg)));
}
```

**❌ DON'T: Process Sequentially When Unnecessary**

```typescript
// Bad: Sequential processing
export async function processMessages(messages: Message[]): Promise<Result[]> {
  const results = [];
  for (const msg of messages) {
    results.push(await processMessage(msg)); // Slow!
  }
  return results;
}
```

## Security Best Practices

### 1. API Key Management

**✅ DO: Use Environment Variables**

```typescript
export const config = {
  apiKey: process.env.API_KEY,
  secretKey: process.env.SECRET_KEY,
};

// Validate at startup
if (!config.apiKey) {
  throw new Error('API_KEY environment variable required');
}
```

**❌ DON'T: Hardcode Secrets**

```typescript
// Bad: Never do this!
export const config = {
  apiKey: 'sk-1234567890abcdef',
  secretKey: 'secret123',
};
```

### 2. Input Validation

**✅ DO: Validate All External Input**

```typescript
export const validateMessage: Evaluator = {
  async evaluate({ message }): Promise<boolean> {
    // Validate message structure
    if (!message.content || typeof message.content !== 'string') {
      return false;
    }

    // Validate content length
    if (message.content.length > 10000) {
      return false;
    }

    // Validate against injection attacks
    if (containsSqlInjection(message.content)) {
      return false;
    }

    return true;
  },
};
```

### 3. Rate Limiting

**✅ DO: Implement Rate Limiting**

```typescript
export class RateLimiter {
  private requests = new Map<string, number[]>();
  private readonly limit = 100;
  private readonly window = 60 * 1000; // 1 minute

  canMakeRequest(userId: string): boolean {
    const now = Date.now();
    const userRequests = this.requests.get(userId) || [];

    // Remove old requests
    const recentRequests = userRequests.filter((time) => now - time < this.window);

    if (recentRequests.length >= this.limit) {
      return false;
    }

    recentRequests.push(now);
    this.requests.set(userId, recentRequests);
    return true;
  }
}
```

## Testing Best Practices

### 1. Unit Testing

```typescript
// Good: Comprehensive unit tests
describe('GreetingAction', () => {
  let runtime: MockRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it('should generate appropriate greeting', async () => {
    const message = createMessage('Hello');
    const result = await greetingAction.handler({
      runtime,
      message,
      state: {},
    });

    expect(result.text).toContain('Hello');
  });

  it('should handle empty messages', async () => {
    const message = createMessage('');
    const result = await greetingAction.handler({
      runtime,
      message,
      state: {},
    });

    expect(result.text).toBeDefined();
  });
});
```

### 2. Integration Testing

```typescript
// Test full plugin integration
describe('Plugin Integration', () => {
  let runtime: IAgentRuntime;

  beforeAll(async () => {
    runtime = await createTestRuntime();
    await runtime.loadPlugin(myPlugin);
  });

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('should process messages end-to-end', async () => {
    const response = await runtime.processMessage({
      content: 'Test message',
      userId: 'test-user',
    });

    expect(response).toBeDefined();
    expect(response.success).toBe(true);
  });
});
```

## Documentation Best Practices

### 1. Code Documentation

````typescript
/**
 * Processes incoming messages and generates appropriate responses.
 *
 * @param message - The incoming message to process
 * @param context - Additional context for message processing
 * @returns Promise resolving to the response message
 *
 * @example
 * ```typescript
 * const response = await processMessage(
 *   { content: "Hello", userId: "123" },
 *   { sessionId: "abc" }
 * );
 * ```
 *
 * @throws {ValidationError} If message format is invalid
 * @throws {ProcessingError} If message processing fails
 */
export async function processMessage(message: Message, context?: Context): Promise<Response> {
  // Implementation
}
````

### 2. API Documentation

```typescript
// Document public APIs clearly
export interface ActionHandler {
  /**
   * Executes the action with the given parameters.
   *
   * @param params - Action execution parameters
   * @param params.runtime - The agent runtime instance
   * @param params.message - The message triggering this action
   * @param params.state - Current conversation state
   *
   * @returns Action result or null if action cannot handle the message
   */
  (params: ActionParams): Promise<ActionResult | null>;
}
```

## Deployment Best Practices

### 1. Environment Configuration

```bash
# Production configuration
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgresql://...
REDIS_URL=redis://...

# Feature flags
ENABLE_CACHE=true
ENABLE_METRICS=true
ENABLE_PROFILING=false
```

### 2. Health Checks

```typescript
export const healthCheck: Action = {
  name: 'HEALTH_CHECK',
  handler: async ({ runtime }) => {
    const checks = {
      database: await checkDatabase(runtime),
      memory: checkMemoryUsage(),
      services: await checkServices(runtime),
      uptime: process.uptime(),
    };

    const healthy = Object.values(checks).every((check) => check !== false);

    return {
      status: healthy ? 'healthy' : 'unhealthy',
      checks,
    };
  },
};
```

### 3. Monitoring and Metrics

```typescript
export class MetricsCollector {
  private metrics = {
    messagesProcessed: 0,
    errors: 0,
    avgResponseTime: 0,
  };

  recordMessage(duration: number): void {
    this.metrics.messagesProcessed++;
    this.updateAvgResponseTime(duration);
  }

  recordError(): void {
    this.metrics.errors++;
  }

  getMetrics(): Metrics {
    return { ...this.metrics };
  }
}
```

## Common Pitfalls to Avoid

### 1. Memory Leaks

**❌ Avoid: Unbounded Collections**

```typescript
// Bad: Grows forever
class MessageHistory {
  private messages: Message[] = [];

  addMessage(msg: Message): void {
    this.messages.push(msg); // Never cleaned!
  }
}
```

**✅ Fix: Implement Bounds**

```typescript
// Good: Bounded collection
class MessageHistory {
  private messages: Message[] = [];
  private readonly maxSize = 1000;

  addMessage(msg: Message): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxSize) {
      this.messages.shift(); // Remove oldest
    }
  }
}
```

### 2. Blocking Operations

**❌ Avoid: Synchronous I/O**

```typescript
// Bad: Blocks event loop
import { readFileSync } from 'fs';

export function loadConfig(): Config {
  const data = readFileSync('config.json', 'utf8');
  return JSON.parse(data);
}
```

**✅ Fix: Use Async Operations**

```typescript
// Good: Non-blocking
import { readFile } from 'fs/promises';

export async function loadConfig(): Promise<Config> {
  const data = await readFile('config.json', 'utf8');
  return JSON.parse(data);
}
```

### 3. Poor Error Messages

**❌ Avoid: Generic Errors**

```typescript
// Bad: Not helpful
throw new Error('Operation failed');
```

**✅ Fix: Descriptive Errors**

```typescript
// Good: Informative
throw new Error(`Failed to connect to database at ${dbUrl}: ${error.message}`);
```

## Conclusion

Following these best practices will help you build robust, scalable, and maintainable ElizaOS applications. Remember:

1. **Keep it simple**: Don't over-engineer solutions
2. **Handle errors gracefully**: Plan for failure scenarios
3. **Document your code**: Future you will thank present you
4. **Test thoroughly**: Automated tests save time
5. **Monitor production**: You can't fix what you can't see

For more specific guidance, see:

- [Architecture Overview](../architecture/overview.md)
- [Core Concepts](../architecture/core-concepts.md)
- [Plugin Development Guide](/docs/development/plugin-guide)
