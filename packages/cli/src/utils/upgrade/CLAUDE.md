# ElizaOS Plugin Migration Guide (0.x to 1.x)

This document contains the migration instructions for upgrading ElizaOS plugins from version 0.x to 1.x.

## Core Migration Requirements

### 1. Import Path Updates

All @elizaos imports must be updated to use the new paths:

```typescript
// Old
import { elizaLogger } from '@elizaos/core';
import { AgentRuntime, IAgentRuntime } from '@elizaos/core';
import { Account } from '@elizaos/core';

// New
import { logger } from '@elizaos/core';
import { AgentRuntime } from '@elizaos/core';
import { Entity } from '@elizaos/core';
```

### 2. Type Migrations

Update all type references:

- `Account` → `Entity`
- `userId` → `entityId`
- `room` → `world` (agent-side abstraction only)
- `IAgentRuntime` → `AgentRuntime`

### 3. Service Architecture

Services must now extend the base Service class and implement lifecycle methods:

```typescript
import { Service } from '@elizaos/core';

export class MyService extends Service {
  async initialize(): Promise<void> {
    // Service initialization logic
  }

  async start(): Promise<void> {
    // Service startup logic
  }

  async stop(): Promise<void> {
    // Service cleanup logic
  }
}
```

### 4. Event System

Implement proper event emission and handling:

```typescript
// Emit events
this.runtime.emit('eventName', eventData);

// Listen to events
this.runtime.on('eventName', (data) => {
  // Handle event
});
```

### 5. Memory Operations

Update to use new API with table names:

```typescript
// Old
await runtime.memory.remember(userId, roomId, content);

// New
await runtime.memory.create({
  entityId,
  worldId,
  content,
  tableName: 'memories',
});
```

### 6. Model Usage

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

### 7. Template Migration

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

### 8. Testing Requirements

Create comprehensive unit and integration tests:

- Test all actions, providers, evaluators
- Test service initialization and lifecycle
- Test event handling
- Test memory operations
- Test error handling

### 9. Plugin Structure

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

### 10. Package.json Updates

Update dependencies and scripts:

```json
{
  "dependencies": {
    "@elizaos/core": "^1.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsup",
    "dev": "tsup --watch"
  },
  "devDependencies": {
    "vitest": "^1.3.1",
    "tsup": "8.5.0"
  }
}
```

## Component Specifications

### Actions

- Define agent capabilities and response mechanisms
- Implement validation functions
- Provide handler that generates responses

### Providers

- Supply dynamic contextual information
- Bridge between agent and external systems
- Format information for conversation templates

### Evaluators

- Post-interaction cognitive processing
- Knowledge extraction and storage
- Relationship tracking

### Services

- Specialized interface per platform
- Maintain consistent agent behavior
- Core component of the system

## Important Notes

- Never use stubs or incomplete code
- Always write comprehensive tests
- Follow test-driven development
- Ensure proper error handling
- Use TypeScript for all code
- Clear separation of concerns
