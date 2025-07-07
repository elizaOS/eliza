# Frequently Asked Questions (Technical)

Technical questions and in-depth answers for developers working with ElizaOS.

## 🏗️ Architecture & Design

### Q: Why does ElizaOS use UUID swizzling for rooms?

ElizaOS implements deterministic UUID generation where each agent sees the same physical room with a different UUID. This design enables:

1. **Memory Isolation**: Each agent's memories are completely isolated
2. **Cross-Agent Communication**: Agents can still reference the same physical space
3. **Consistent Identity**: Platform IDs remain stable while internal IDs are agent-specific

```typescript
// Each agent generates its own view of the room
const roomId = generateDeterministicUUID(agentId, platformRoomId);
```

### Q: How does the plugin loading order affect system behavior?

Plugin loading order is critical because:

1. **Service Registration**: Earlier plugins register services that later plugins depend on
2. **Handler Priority**: First-loaded plugins have higher priority for handling messages
3. **Provider Precedence**: Earlier providers override later ones for the same data

Loading order:

```typescript
// 1. Core infrastructure (database)
// 2. AI providers (text-only first, then embedding-capable)
// 3. Platform adapters
// 4. Feature plugins
// 5. Bootstrap (default handlers - always last)
```

### Q: What's the difference between Actions, Providers, and Evaluators?

| Component      | Purpose                       | Execution                 | Example                             |
| -------------- | ----------------------------- | ------------------------- | ----------------------------------- |
| **Actions**    | Perform discrete behaviors    | On-demand when detected   | Send email, create post             |
| **Providers**  | Supply contextual information | Every message for context | Time, weather, user data            |
| **Evaluators** | Post-process interactions     | After response generation | Sentiment analysis, fact extraction |

### Q: How does memory consolidation work?

Memory consolidation follows a multi-stage process:

```typescript
// 1. Short-term buffer (last N messages)
// 2. Importance evaluation
// 3. Embedding generation for important memories
// 4. Long-term storage with decay factor
// 5. Periodic consolidation of similar memories
```

Memories are scored based on:

- Emotional salience
- Information density
- Repetition frequency
- Explicit importance markers

## 💻 Development

### Q: Monorepo vs Standalone - when to use which?

**Use Monorepo Development when:**

- Contributing to ElizaOS core
- Developing plugins for distribution
- Need to modify core functionality
- Testing against latest changes

**Use Standalone Projects when:**

- Building production agents
- Creating private/proprietary features
- Want stable, versioned dependencies
- Deploying to production

### Q: How do I properly handle async operations in plugins?

Always use proper error handling and cleanup:

```typescript
class MyPlugin implements Plugin {
  private cleanup: (() => Promise<void>)[] = [];

  async initialize(runtime: AgentRuntime): Promise<void> {
    // Setup resources
    const connection = await createConnection();
    this.cleanup.push(() => connection.close());

    // Register handlers with error boundaries
    runtime.on('message', this.wrapHandler(this.handleMessage));
  }

  private wrapHandler(handler: Function) {
    return async (...args: any[]) => {
      try {
        await handler.apply(this, args);
      } catch (error) {
        console.error('Handler error:', error);
        // Don't let plugin errors crash the runtime
      }
    };
  }

  async shutdown(): Promise<void> {
    // Clean up in reverse order
    for (const cleanupFn of this.cleanup.reverse()) {
      await cleanupFn();
    }
  }
}
```

### Q: What's the proper way to extend the database schema?

Use migrations with your plugin:

```typescript
// plugins/my-plugin/src/migrations/001_initial.sql
CREATE TABLE IF NOT EXISTS my_plugin_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_my_plugin_agent ON my_plugin_data(agent_id);
```

Then in your plugin:

```typescript
async initialize(runtime: AgentRuntime): Promise<void> {
    const db = runtime.getService<IDatabaseService>('database');
    await db.migrate(__dirname + '/migrations');
}
```

### Q: How do I implement custom model providers?

Implement the `IModelProvider` interface:

```typescript
class CustomModelProvider implements IModelProvider {
  async generateText(prompt: string, options: ModelOptions): Promise<string> {
    // Your implementation
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Return embedding vector
  }

  async isAvailable(): Promise<boolean> {
    // Check if provider is configured
  }
}

// Register in plugin
const provider = new CustomModelProvider();
runtime.registerModelProvider('custom', provider);
```

## 🔧 Performance & Optimization

### Q: How can I optimize memory searches?

1. **Use Embeddings Efficiently**:

   ```typescript
   // Cache embeddings for frequently searched queries
   const embeddingCache = new LRUCache<string, number[]>(1000);
   ```

2. **Implement Pagination**:

   ```typescript
   // Don't load all memories at once
   const memories = await db.searchMemories(query, {
     limit: 50,
     offset: page * 50,
   });
   ```

3. **Use Indexes**:

   ```sql
   CREATE INDEX idx_memories_embedding ON memories
   USING ivfflat (embedding vector_cosine_ops);
   ```

### Q: What's the recommended way to handle rate limiting?

Implement exponential backoff with jitter:

```typescript
class RateLimiter {
  private attempts = 0;

  async execute<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    try {
      const result = await fn();
      this.attempts = 0;
      return result;
    } catch (error) {
      if (this.isRateLimitError(error) && this.attempts < maxAttempts) {
        this.attempts++;
        const delay = Math.min(1000 * Math.pow(2, this.attempts), 30000);
        const jitter = Math.random() * delay * 0.1;
        await sleep(delay + jitter);
        return this.execute(fn, maxAttempts);
      }
      throw error;
    }
  }
}
```

### Q: How do I profile and optimize agent performance?

Use built-in performance monitoring:

```typescript
// Enable performance tracking
runtime.enablePerfMonitoring({
  sampleRate: 0.1, // Sample 10% of requests
  slowThreshold: 1000, // Log requests over 1s
});

// Add custom metrics
runtime.metrics.histogram('custom.operation.duration').record(duration);
runtime.metrics.counter('custom.operation.count').increment();
```

## 🔐 Security

### Q: How do I safely store sensitive data?

1. **Never store sensitive data in character files**
2. **Use environment variables for secrets**
3. **Encrypt data at rest**:

```typescript
class SecureStorage {
  async store(key: string, value: any): Promise<void> {
    const encrypted = await encrypt(JSON.stringify(value), this.key);
    await this.db.set(key, encrypted);
  }

  async retrieve(key: string): Promise<any> {
    const encrypted = await this.db.get(key);
    const decrypted = await decrypt(encrypted, this.key);
    return JSON.parse(decrypted);
  }
}
```

### Q: What security considerations exist for plugin development?

1. **Input Validation**: Always validate external input
2. **SQL Injection**: Use parameterized queries
3. **Resource Limits**: Implement timeouts and memory limits
4. **Sandboxing**: Don't use `eval()` or dynamic code execution
5. **Permissions**: Request minimum necessary permissions

## 🐛 Debugging & Troubleshooting

### Q: How do I debug memory-related issues?

Enable debug logging for memory operations:

```typescript
// Set in environment
LOG_LEVEL = debug;
DEBUG_MEMORY = true;

// Or programmatically
runtime.setLogLevel('debug');
runtime.memory.enableDebugMode();
```

Use memory inspection tools:

```typescript
// Dump memory state
const memoryState = await runtime.memory.debugDump();
console.log(JSON.stringify(memoryState, null, 2));

// Analyze memory usage
const stats = await runtime.memory.getStatistics();
```

### Q: Why are my plugins not loading?

Common issues and solutions:

1. **Check Plugin Structure**:

   ```typescript
   // Plugin must export default
   export default {
       name: 'my-plugin',
       actions: [...],
       providers: [...],
       // ...
   };
   ```

2. **Verify Dependencies**:

   ```bash
   # Check for missing dependencies
   bun pm ls
   ```

3. **Enable Plugin Debug Logging**:

   ```typescript
   DEBUG_PLUGINS=true bun start
   ```

### Q: How do I handle plugin conflicts?

1. **Namespace your actions**:

   ```typescript
   actions: [
       { name: 'MY_PLUGIN_ACTION', ... }
   ]
   ```

2. **Use service discovery**:

   ```typescript
   const service = runtime.hasService('myService')
     ? runtime.getService('myService')
     : this.createDefaultService();
   ```

3. **Implement feature detection**:

   ```typescript
   if (runtime.supports('feature-name')) {
     // Use feature
   }
   ```

## 🚀 Deployment & Scaling

### Q: How do I horizontally scale ElizaOS agents?

1. **Stateless Agents**: Keep agents stateless with shared backend
2. **Distributed Cache**: Use Redis for shared state
3. **Database Pooling**: Configure connection pooling
4. **Load Balancing**: Use sticky sessions for websockets

```typescript
// Example Redis configuration
const redis = new Redis.Cluster([
  { host: 'redis-1', port: 6379 },
  { host: 'redis-2', port: 6379 },
  { host: 'redis-3', port: 6379 },
]);
```

### Q: How do I monitor agents in production?

Implement comprehensive monitoring:

```typescript
// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      database: await db.ping(),
      memory: runtime.memory.getHealth(),
      plugins: runtime.getPluginHealth(),
    },
    metrics: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      responses: await metrics.getResponseStats(),
    },
  };
  res.json(health);
});
```

### Q: What's the best way to handle agent updates?

Use blue-green deployment:

```bash
# 1. Deploy new version to staging
docker-compose -f docker-compose.staging.yml up -d

# 2. Test new version
bun run test:e2e -- --env=staging

# 3. Switch traffic gradually
# Update load balancer to route 10%, 50%, then 100%

# 4. Monitor for errors
bun run monitor:errors
```

### Q: What's the recommended production deployment?

```yaml
# docker-compose.yml for production
version: '3.8'
services:
  agent:
    image: elizaos/agent:latest
    deploy:
      replicas: 3
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://...
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
```

## 📚 Advanced Topics

### Q: How do I implement custom memory consolidation strategies?

```typescript
class CustomConsolidator implements IMemoryConsolidator {
  async consolidate(memories: Memory[]): Promise<Memory[]> {
    // Group similar memories
    const groups = this.groupBySimilarity(memories);

    // Create summary memories
    const consolidated = groups.map((group) => ({
      type: 'consolidated',
      content: this.summarize(group),
      sources: group.map((m) => m.id),
      importance: Math.max(...group.map((m) => m.importance)),
    }));

    return consolidated;
  }
}
```

### Q: How do I implement multi-modal agents?

```typescript
class MultiModalAgent extends BaseAgent {
  async processMessage(message: Message): Promise<void> {
    // Handle text
    if (message.content.text) {
      const textResponse = await this.generateTextResponse(message);
      await this.send(textResponse);
    }

    // Handle images
    if (message.content.attachments?.some((a) => a.type === 'image')) {
      const imageAnalysis = await this.analyzeImages(message.content.attachments);
      const response = await this.generateResponseFromImage(imageAnalysis);
      await this.send(response);
    }

    // Handle audio
    if (message.content.attachments?.some((a) => a.type === 'audio')) {
      const transcript = await this.transcribeAudio(message.content.attachments);
      const response = await this.generateAudioResponse(transcript);
      await this.sendAudio(response);
    }
  }
}
```

### Q: How do I implement custom conversation flows?

```typescript
class ConversationFlow {
  private state: Map<string, any> = new Map();
  private steps: FlowStep[] = [];

  async execute(userId: string, input: any): Promise<FlowResult> {
    const currentStep = this.getCurrentStep(userId);
    const validation = await currentStep.validate(input);

    if (!validation.valid) {
      return {
        type: 'retry',
        message: validation.error,
        step: currentStep,
      };
    }

    // Store step data
    this.state.set(`${userId}.${currentStep.id}`, input);

    // Check if flow is complete
    if (currentStep.isLast) {
      return {
        type: 'complete',
        data: this.getFlowData(userId),
      };
    }

    // Advance to next step
    const nextStep = currentStep.getNext(input);
    return {
      type: 'continue',
      step: nextStep,
      message: nextStep.prompt,
    };
  }
}
```

### Q: Can I implement custom transport layers?

Yes, implement the `ITransport` interface:

```typescript
class CustomTransport implements ITransport {
  async start(): Promise<void> {
    /* ... */
  }
  async stop(): Promise<void> {
    /* ... */
  }
  async send(message: Message): Promise<void> {
    /* ... */
  }

  on(event: string, handler: Function): void {
    // Handle platform events
  }
}
```

## 🆘 Getting Help

### Technical Resources

- **[Core API Documentation](/docs/technical/api-reference/core-api)** - Core API reference
- **[Actions API Documentation](/docs/technical/api-reference/actions-api)** - Actions API reference
- **[GitHub Discussions](https://github.com/elizaOS/eliza/discussions)** - Technical discussions
- **[Discord #dev Channel](https://discord.gg/elizaos)** - Developer chat
- **[Example Plugins](https://github.com/elizaOS/eliza/tree/main/packages)** - Reference implementations

### Debugging Tools

- **Runtime Inspector**: `bun run inspect`
- **Memory Analyzer**: `bun run analyze-memory`
- **Performance Profiler**: `bun run profile`
- **Plugin Validator**: `bun run validate-plugin`
- **Message Tracer**: `bun run trace-messages`
- **Database Query Analyzer**: `bun run analyze-queries`

### Development Workflow Tips

1. **Use TypeScript strict mode** for better error catching
2. **Set up pre-commit hooks** to run tests and linting
3. **Use dependency injection** for better testability
4. **Implement circuit breakers** for external services
5. **Use structured logging** with correlation IDs
6. **Write integration tests** for complex workflows
7. **Monitor memory usage** during development
8. **Use feature flags** for gradual rollouts

### Performance Benchmarks

| Metric             | Target      | Good        | Needs Improvement |
| ------------------ | ----------- | ----------- | ----------------- |
| Response Time      | Under 200ms | Under 500ms | Over 1000ms       |
| Memory Usage       | Under 100MB | Under 500MB | Over 1GB          |
| Concurrent Users   | 1000+       | 100+        | Under 50          |
| Message Throughput | 100/s       | 50/s        | Under 10/s        |
| Plugin Load Time   | Under 1s    | Under 3s    | Over 5s           |

### Common Error Codes

| Code | Meaning             | Solution                |
| ---- | ------------------- | ----------------------- |
| E001 | Plugin load failure | Check plugin structure  |
| E002 | Memory corruption   | Rebuild memory index    |
| E003 | Service unavailable | Check service health    |
| E004 | Rate limit exceeded | Implement backoff       |
| E005 | Invalid character   | Validate character.json |

## 🤝 Contributing & Community

### Q: How do I contribute to ElizaOS core?

1. **Fork the repository** and create a feature branch
2. **Read the contributing guide** at `/CONTRIBUTING.md`
3. **Follow the RFC process** for major changes
4. **Write comprehensive tests** for new features
5. **Update documentation** for any API changes
6. **Submit a pull request** with detailed description

### Q: What's the process for proposing new features?

1. **Search existing RFCs** in GitHub Discussions
2. **Create a detailed proposal** with:
   - Problem statement
   - Proposed solution
   - Alternative approaches
   - Implementation plan
   - Breaking changes (if any)
3. **Gather community feedback**
4. **Implement based on consensus**

### Q: How do I create a plugin for the marketplace?

```typescript
// 1. Use the plugin template
bunx create-eliza-plugin my-awesome-plugin

// 2. Implement your plugin following patterns
// 3. Add comprehensive tests
// 4. Create documentation
// 5. Publish to npm
bun publish

// 6. Submit to marketplace
// Create PR to add your plugin to the registry
```

---

🎤 **Office Hours**: Join our weekly developer Q&A every Thursday at 2 PM PST
💬 **Discord**: Get help in [#dev-help](https://discord.gg/elizaos)
📝 **GitHub**: [Open issues](https://github.com/elizaOS/eliza/issues) and [discussions](https://github.com/elizaOS/eliza/discussions)
📧 **Email**: Technical questions to [dev-support@elizaos.ai](mailto:dev-support@elizaos.ai)
