# ElizaOS - High-Level System Orchestrator

## Overview

ElizaOS is a high-level global orchestrator that provides a unified interface for managing the entire ElizaOS ecosystem. It acts as a container for agents, plugins, services, and the server, offering centralized control and monitoring capabilities.

## Architecture

```typescript
const elizaos = new ElizaOS({
  name: 'MyElizaOS',
  serverConfig: { enabled: true, port: 3000 },
  globalPlugins: [corePlugin, customPlugin],
  maxAgents: 10,
  clustering: true
});
```

## Key Features

### 1. **Centralized Agent Management**
- Create, start, stop, and remove multiple agents
- Monitor agent status and health
- Execute operations within agent context
- Enforce agent limits and resource constraints

### 2. **Global Plugin Registry**
- Register plugins available to all agents
- Share services and capabilities across the system
- Dynamic plugin loading and unloading

### 3. **System-Wide Services**
- Global service instances accessible by all agents
- Service lifecycle management
- Service discovery and dependency injection

### 4. **Event System**
- System-wide event emission and handling
- Monitor agent lifecycle events
- Track system health and performance metrics

### 5. **Server Integration**
- Built-in server management
- RESTful API and WebSocket support
- Auto-scaling and clustering capabilities

## Basic Usage

### Initialize ElizaOS

```typescript
import { ElizaOS } from '@elizaos/core';

// Create and initialize ElizaOS
const elizaos = new ElizaOS({
  name: 'ProductionSystem',
  debug: false,
  serverConfig: {
    enabled: true,
    port: process.env.PORT || 3000,
    host: '0.0.0.0'
  }
});

await elizaos.initialize();
```

### Create and Manage Agents

```typescript
// Create an agent
const agentId = await elizaos.createAgent({
  character: myCharacter,
  plugins: [customPlugin],
  autoStart: true
});

// Get agent info
const agent = elizaos.getAgent(agentId);
console.log(`Agent ${agent.name} is ${agent.status}`);

// Execute within agent context
const result = await elizaos.withAgent(agentId, async (runtime) => {
  // Access the agent's runtime directly
  return await runtime.processMessage({
    text: 'Hello!',
    userId: 'user123',
    roomId: 'room456'
  });
});

// Stop an agent
await elizaos.stopAgent(agentId);

// Remove an agent
await elizaos.removeAgent(agentId);
```

### Global Plugins

```typescript
// Register a global plugin (available to all agents)
await elizaos.registerGlobalPlugin(myPlugin);

// Unregister a plugin
await elizaos.unregisterGlobalPlugin('my-plugin');

// Global plugins are automatically available to new agents
const agentId = await elizaos.createAgent({
  character: myCharacter
  // Will have access to all global plugins
});
```

### Global Services

```typescript
// Register a global service
await elizaos.registerGlobalService('database', databaseService);

// Access global service from anywhere
const db = elizaos.getGlobalService('database');

// Services are accessible within agents
await elizaos.withAgent(agentId, async (runtime) => {
  // Agent can access global services through its runtime
  const db = runtime.getService('database');
  await db.query('...');
});
```

### Event Handling

```typescript
// Listen to system events
elizaos.on(ElizaOSEventType.AGENT_CREATED, (event) => {
  console.log(`New agent created: ${event.data.agentId}`);
});

elizaos.on(ElizaOSEventType.AGENT_ERROR, (event) => {
  console.error(`Agent error: ${event.data.error}`);
  // Implement error recovery
});

elizaos.on(ElizaOSEventType.SYSTEM_OVERLOADED, (event) => {
  console.warn('System overloaded, scaling up...');
  // Implement auto-scaling logic
});

// Emit custom events
elizaos.emit({
  type: 'CUSTOM_EVENT',
  timestamp: Date.now(),
  data: { custom: 'data' }
});
```

### System Monitoring

```typescript
// Get system status
const status = elizaos.getSystemStatus();
console.log({
  totalAgents: status.totalAgents,
  activeAgents: status.activeAgents,
  memoryUsage: status.memoryUsage,
  uptime: status.uptime,
  services: status.services,
  plugins: status.plugins
});

// Health check
const isHealthy = await elizaos.healthCheck();
if (!isHealthy) {
  console.error('System unhealthy, initiating recovery...');
}

// Monitor specific agents
const agentStatus = elizaos.getAgentsByStatus('error');
for (const agent of agentStatus) {
  console.log(`Agent ${agent.name} has errors`);
}
```

### Server Management

```typescript
// Start the server (if configured)
await elizaos.start();

// The server will handle:
// - REST API endpoints
// - WebSocket connections
// - Health check endpoints
// - Metrics endpoints

// Stop the server
await elizaos.stop();
```

### Clustering and Scaling

```typescript
const elizaos = new ElizaOS({
  clustering: true,
  clusterConfig: {
    workers: 4, // Number of worker processes
    autoScale: true,
    maxWorkers: 16,
    scaleThreshold: 0.8 // CPU threshold for scaling
  }
});

// ElizaOS will automatically manage worker processes
// and distribute agents across them
```

## Advanced Features

### Agent Pooling

```typescript
// Configure agent pools for different workloads
const elizaos = new ElizaOS({
  agentPools: {
    'customer-service': {
      minAgents: 2,
      maxAgents: 10,
      character: customerServiceCharacter,
      autoScale: true
    },
    'technical-support': {
      minAgents: 1,
      maxAgents: 5,
      character: techSupportCharacter,
      autoScale: true
    }
  }
});

// Agents will be automatically created/destroyed based on load
```

### Middleware System

```typescript
// Add middleware for all agent interactions
elizaos.use(async (context, next) => {
  console.log(`Processing message for agent ${context.agentId}`);
  const start = Date.now();
  
  await next();
  
  const duration = Date.now() - start;
  console.log(`Message processed in ${duration}ms`);
});

// Add authentication middleware
elizaos.use(async (context, next) => {
  if (!context.authenticated) {
    throw new Error('Unauthorized');
  }
  await next();
});
```

### Resource Management

```typescript
const elizaos = new ElizaOS({
  resourceLimits: {
    maxMemoryPerAgent: '512MB',
    maxCPUPerAgent: 0.5,
    maxRequestsPerMinute: 100,
    maxConcurrentRequests: 50
  }
});

// ElizaOS will enforce these limits automatically
```

### Persistence and Recovery

```typescript
const elizaos = new ElizaOS({
  persistence: {
    enabled: true,
    checkpointInterval: 60000, // Save state every minute
    recoveryMode: 'automatic'
  }
});

// System state will be automatically saved and can be recovered
// after crashes or restarts
```

## API Reference

### Constructor Options

```typescript
interface ElizaOSConfig {
  name?: string;
  databaseAdapter?: IDatabaseAdapter;
  globalPlugins?: Plugin[];
  defaultSettings?: RuntimeSettings;
  debug?: boolean;
  serverConfig?: {
    enabled: boolean;
    port?: number;
    host?: string;
    cors?: boolean;
    rateLimit?: boolean;
  };
  maxAgents?: number;
  clustering?: boolean;
  clusterConfig?: ClusterConfig;
  agentPools?: Record<string, AgentPoolConfig>;
  resourceLimits?: ResourceLimits;
  persistence?: PersistenceConfig;
}
```

### Methods

#### System Management
- `initialize(): Promise<void>` - Initialize the ElizaOS system
- `start(): Promise<void>` - Start the ElizaOS server and services
- `stop(): Promise<void>` - Stop all agents and services
- `reset(): Promise<void>` - Reset the entire system
- `healthCheck(): Promise<boolean>` - Check system health

#### Agent Management
- `createAgent(options: CreateAgentOptions): Promise<UUID>` - Create a new agent
- `startAgent(agentId: UUID): Promise<void>` - Start a specific agent
- `stopAgent(agentId: UUID): Promise<void>` - Stop a specific agent
- `removeAgent(agentId: UUID): Promise<void>` - Remove an agent
- `getAgent(agentId: UUID): AgentInfo | undefined` - Get agent information
- `getAllAgents(): AgentInfo[]` - Get all agents
- `getAgentsByStatus(status: AgentStatus): AgentInfo[]` - Get agents by status
- `withAgent<T>(agentId: UUID, fn: (runtime: IAgentRuntime) => Promise<T>): Promise<T>` - Execute function with agent context

#### Plugin Management
- `registerGlobalPlugin(plugin: Plugin): Promise<void>` - Register a global plugin
- `unregisterGlobalPlugin(name: string): Promise<void>` - Unregister a global plugin

#### Service Management
- `registerGlobalService(name: ServiceTypeName, service: Service): Promise<void>` - Register a global service
- `unregisterGlobalService(name: ServiceTypeName): Promise<void>` - Unregister a global service
- `getGlobalService<T extends Service>(name: ServiceTypeName): T | undefined` - Get a global service

#### Event Management
- `on(event: ElizaOSEventType, handler: ElizaOSEventHandler): void` - Add event listener
- `off(event: ElizaOSEventType, handler: ElizaOSEventHandler): void` - Remove event listener
- `emit(event: ElizaOSEvent): void` - Emit an event

#### Monitoring
- `getSystemStatus(): SystemStatus` - Get comprehensive system status

### Events

```typescript
enum ElizaOSEventType {
  SYSTEM_STARTED = 'system:started',
  SYSTEM_STOPPED = 'system:stopped',
  SYSTEM_ERROR = 'system:error',
  SYSTEM_OVERLOADED = 'system:overloaded',
  
  AGENT_CREATED = 'agent:created',
  AGENT_STARTED = 'agent:started',
  AGENT_STOPPED = 'agent:stopped',
  AGENT_REMOVED = 'agent:removed',
  AGENT_ERROR = 'agent:error',
  
  PLUGIN_REGISTERED = 'plugin:registered',
  PLUGIN_UNREGISTERED = 'plugin:unregistered',
  
  SERVICE_REGISTERED = 'service:registered',
  SERVICE_UNREGISTERED = 'service:unregistered',
  SERVICE_ERROR = 'service:error'
}
```

## Best Practices

1. **Always initialize before use**: Call `elizaos.initialize()` before any other operations
2. **Handle errors gracefully**: Use try-catch blocks and listen to error events
3. **Monitor system health**: Regularly check system status and implement recovery strategies
4. **Use global plugins wisely**: Only register truly global functionality as global plugins
5. **Implement graceful shutdown**: Handle SIGINT/SIGTERM signals to cleanly shutdown
6. **Set resource limits**: Configure appropriate limits to prevent resource exhaustion
7. **Use event system for monitoring**: Listen to system events for logging and alerting
8. **Leverage agent pools**: Use pools for predictable workloads to improve efficiency

## Migration from AgentRuntime

If you're currently using `AgentRuntime` directly, migrating to `ElizaOS` provides additional benefits:

### Before (Direct AgentRuntime)
```typescript
const runtime = new AgentRuntime({
  character: myCharacter,
  plugins: [plugin1, plugin2],
  databaseAdapter: dbAdapter
});

await runtime.initialize();
```

### After (Using ElizaOS)
```typescript
const elizaos = new ElizaOS({
  globalPlugins: [plugin1, plugin2],
  databaseAdapter: dbAdapter
});

await elizaos.initialize();

const agentId = await elizaos.createAgent({
  character: myCharacter,
  autoStart: true
});

// Now you have system-wide management capabilities
```

## Example: Production Setup

```typescript
import { ElizaOS } from '@elizaos/core';
import { config } from './config';
import { logger } from './logger';

async function startProduction() {
  const elizaos = new ElizaOS({
    name: 'ProductionElizaOS',
    debug: false,
    serverConfig: {
      enabled: true,
      port: config.port,
      host: '0.0.0.0',
      cors: true,
      rateLimit: true
    },
    maxAgents: config.maxAgents,
    clustering: true,
    clusterConfig: {
      workers: config.workers,
      autoScale: true,
      maxWorkers: config.maxWorkers
    },
    resourceLimits: {
      maxMemoryPerAgent: config.memoryLimit,
      maxCPUPerAgent: config.cpuLimit
    },
    persistence: {
      enabled: true,
      checkpointInterval: 60000
    }
  });

  // Set up event monitoring
  elizaos.on(ElizaOSEventType.SYSTEM_ERROR, (event) => {
    logger.error('System error:', event.data);
    // Send alert to monitoring service
  });

  elizaos.on(ElizaOSEventType.AGENT_ERROR, (event) => {
    logger.error(`Agent ${event.data.agentId} error:`, event.data.error);
    // Attempt recovery
  });

  // Initialize and start
  await elizaos.initialize();
  
  // Create initial agent pool
  for (const agentConfig of config.agents) {
    await elizaos.createAgent({
      character: agentConfig.character,
      plugins: agentConfig.plugins,
      autoStart: true
    });
  }

  await elizaos.start();
  
  logger.info('ElizaOS Production System Started');
  logger.info(`Server running on port ${config.port}`);
  logger.info(`Total agents: ${elizaos.getAllAgents().length}`);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully...');
    await elizaos.stop();
    process.exit(0);
  });
}

startProduction().catch((error) => {
  logger.error('Failed to start:', error);
  process.exit(1);
});
```

## Conclusion

ElizaOS provides a powerful, scalable foundation for building and managing AI agent systems. By centralizing control and providing robust management features, it enables developers to focus on agent logic while the system handles orchestration, scaling, and reliability.

