# ElizaOS Plugin Migration Guide (0.x to 1.x)

This document contains the migration instructions for upgrading ElizaOS plugins from version 0.x to 1.x.

## Core Migration Requirements

### 1. Import Path Updates

**CRITICAL: All elizaos imports MUST come from @elizaos/core ONLY. There are NO separate packages for logger, utils, etc. Plugins should use service interfaces, not direct imports from other plugins unless absolutely necessary**

```typescript
// Old - various imports from @elizaos/core
import { elizaLogger } from '@elizaos/core';
import { AgentRuntime, IAgentRuntime } from '@elizaos/core';
import { Account } from '@elizaos/core';

// New - STILL from @elizaos/core, just different exports
import { logger } from '@elizaos/core';
import { AgentRuntime } from '@elizaos/core';
import { Entity } from '@elizaos/core';
```

**IMPORTANT: Do NOT split imports into separate packages like:**

- ❌ `@elizaos/plugin` - DOES NOT EXIST
- ❌ `@elizaos/types` - DOES NOT EXIST
- ❌ `@elizaos/logger` - DOES NOT EXIST
- ❌ `@elizaos/models` - DOES NOT EXIST
- ❌ `@elizaos/runtime` - DOES NOT EXIST

**ALL imports must come from `@elizaos/core`:**

```typescript
// ✅ CORRECT - Everything from @elizaos/core
import {
  Plugin,
  Action,
  AgentRuntime,
  logger,
  ModelClass,
  Memory,
  State,
  Content,
  HandlerCallback,
  composeContext,
  IDatabaseAdapter,
} from '@elizaos/core';
```

### 2. Database Compatibility Requirements

**CRITICAL: All plugins MUST be database-agnostic and work with both SQLite and PostgreSQL.**

#### Database Abstraction Rules:

- ✅ Use only `runtime.databaseAdapter` for database operations
- ✅ Use the Memory API: `runtime.createMemory()`, `runtime.searchMemories()`
- ✅ Use the Goals API: `runtime.createGoal()`, `runtime.updateGoal()`
- ✅ Use the Relationships API: `runtime.ensureConnection()`
- ❌ Do NOT import database adapters directly
- ❌ Do NOT use database-specific SQL or queries
- ❌ Do NOT make assumptions about database type

```typescript
// ✅ CORRECT - Database-agnostic memory operations
await runtime.createMemory({
  entityId: message.entityId,
  agentId: runtime.agentId,
  content: { text: 'Important information' },
  roomId: message.roomId,
  embedding: await runtime.embed('Important information'),
});

// ✅ CORRECT - Database-agnostic search
const memories = await runtime.searchMemories({
  text: query,
  entityId: message.entityId,
  count: 10,
});

// ❌ WRONG - Direct database access
import { SqliteDatabaseAdapter } from '@elizaos/plugin-sql';
const adapter = new SqliteDatabaseAdapter();
```

#### Environment Variables:

Plugins should work regardless of database configuration:

- `POSTGRES_URL` - If set, uses PostgreSQL
- `SQLITE_DATA_DIR` - If set, uses SQLite at specified location
- If neither set, defaults to SQLite in `./.elizadb`

### 3. Type Migrations

Update all type references:

- `Account` → `Entity`
- `userId` → `entityId`
- `room` → `world` (agent-side abstraction only)
- `IAgentRuntime` → `AgentRuntime`

### 4. Service Architecture

Services must now extend the base Service class and implement lifecycle methods:

```typescript
import { Service } from '@elizaos/core';

export class MyService extends Service {
  async initialize(): Promise<void> {
    // Service initialization logic
    // Must be database-agnostic
  }

  async start(): Promise<void> {
    // Service startup logic
    // Use runtime.databaseAdapter if needed
  }

  async stop(): Promise<void> {
    // Service cleanup logic
  }
}
```

### 5. Event System

Implement proper event emission and handling:

```typescript
// Emit events
this.runtime.emit('eventName', eventData);

// Listen to events
this.runtime.on('eventName', (data) => {
  // Handle event
});
```

### 6. Memory Operations

Update to use new API with table names:

```typescript
// Old
await runtime.memory.remember(userId, roomId, content);

// New - Database-agnostic
await runtime.createMemory({
  entityId,
  worldId,
  content,
  tableName: 'memories',
});
```

### 7. Model Usage

Convert generateText to runtime.useModel:

```typescript
// Old
const response = await generateText({
  model: 'gpt-4',
  prompt: 'Hello',
});

// New
const response = await runtime.useModel({
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### 8. Template Migration

Migrate templates from JSON to XML format:

```xml
<!-- Old JSON format -->
{
  "greeting": "Hello {{name}}"
}

<!-- New XML format -->
<template>
  <greeting>Hello {{name}}</greeting>
</template>
```

### 9. Testing Requirements

Create comprehensive unit and integration tests:

- Test all actions, providers, evaluators
- Test service initialization and lifecycle
- Test event handling
- Test memory operations with both database types
- Test error handling
- **TEST DATABASE COMPATIBILITY:**

  ```typescript
  describe('Database Compatibility', () => {
    it('should work with SQLite', async () => {
      // Test with SQLITE_DATA_DIR set
    });

    it('should work with PostgreSQL', async () => {
      // Test with POSTGRES_URL set
    });
  });
  ```

### 10. Plugin Structure

Ensure proper plugin structure:

```typescript
export const myPlugin: Plugin = {
  name: 'plugin-name',
  version: '1.0.0',
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
};
```

### 11. Package.json Updates

Update dependencies and scripts:

```json
{
  "dependencies": {
    "@elizaos/core": "^1.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:sqlite": "SQLITE_DATA_DIR=./.test-db vitest run",
    "test:postgres": "POSTGRES_URL=postgresql://test:test@localhost:5432/test vitest run",
    "build": "tsup",
    "dev": "tsup --watch"
  },
  "devDependencies": {
    "vitest": "^1.3.1",
    "tsup": "^8.4.0"
  }
}
```

## Component Specifications

### Actions

- Define agent capabilities and response mechanisms
- Implement validation functions
- Provide handler that generates responses
- **Must be database-agnostic**

### Providers

- Supply dynamic contextual information
- Bridge between agent and external systems
- Format information for conversation templates
- **Use only runtime APIs for data access**

### Evaluators

- Post-interaction cognitive processing
- Knowledge extraction and storage
- Relationship tracking
- **Store data using runtime memory APIs**

### Services

- Specialized interface per platform
- Maintain consistent agent behavior
- Core component of the system
- **Must work with any database backend**

## Production Readiness Checklist

Before considering a plugin production-ready, verify:

- ✅ All imports come from @elizaos/core only
- ✅ No direct database adapter imports
- ✅ Uses runtime APIs for all data operations
- ✅ Works with both SQLite and PostgreSQL
- ✅ Has comprehensive tests for both database types
- ✅ No database-specific code or SQL
- ✅ Proper error handling
- ✅ No stubs or incomplete code
- ✅ Services extend base Service class
- ✅ Actions have validation and handlers
- ✅ All components properly exported

## Important Notes

- Never use stubs or incomplete code
- Always write comprehensive tests
- Follow test-driven development
- Ensure proper error handling
- Use TypeScript for all code
- Clear separation of concerns
- Most base types and stuff are in the @elizaos/core package
- **Database compatibility is MANDATORY - plugins must work with both SQLite and PostgreSQL**
