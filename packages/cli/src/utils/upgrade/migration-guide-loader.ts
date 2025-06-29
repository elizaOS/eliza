import { logger } from '@elizaos/core';

export class MigrationGuideLoader {
  private guides: Map<string, string> = new Map();

  constructor() {
    // Embed all guide content directly to avoid file system issues
    this.loadEmbeddedGuides();
  }

  private loadEmbeddedGuides(): void {
    // COMPLETE COMPREHENSIVE MIGRATION GUIDE FOR ELIZAOS PLUGINS 0.x to 1.x
    const integratedMigrationLoop = `# ElizaOS Plugin Migration Guide (0.x to 1.x) - COMPREHENSIVE VERSION

This is the COMPLETE migration guide for upgrading ElizaOS plugins from version 0.x to 1.x. This guide contains ALL the information needed to successfully migrate any ElizaOS plugin.

## 🎯 CRITICAL MIGRATION OVERVIEW

The migration from ElizaOS 0.x to 1.x involves fundamental changes in:
1. **Import Structure**: All imports from @elizaos/core have changed
2. **Type System**: Account → Entity, userId → entityId, room → world 
3. **Service Architecture**: Services now extend base class with lifecycle
4. **Memory API**: Complete rewrite with table-based operations
5. **Model Integration**: generateText → runtime.useModel pattern
6. **Template System**: JSON → XML format conversion
7. **Test Framework**: Vitest with 95%+ coverage requirement
8. **Build System**: tsup with TypeScript strict mode
9. **Plugin Structure**: New plugin definition format
10. **Package Configuration**: Updated dependencies and scripts

## 📋 STEP-BY-STEP MIGRATION PROCESS

### STEP 1: ANALYSIS & PREPARATION

Before making any changes, analyze the plugin completely:

1. **Identify Components**:
   - Actions (in src/actions/ or similar)
   - Providers (in src/providers/ or similar) 
   - Evaluators (in src/evaluators/ or similar)
   - Services (in src/services/ or similar)
   - Templates (JSON files or embedded)
   - Tests (existing test files)

2. **Check Dependencies**:
   - Current @elizaos packages used
   - Third-party dependencies 
   - Development dependencies
   - Scripts in package.json

3. **Identify Breaking Changes**:
   - elizaLogger → logger imports
   - IAgentRuntime → AgentRuntime
   - Account → Entity usage
   - generateText calls
   - composeContext usage
   - Memory operations
   - Settings imports

### STEP 2: PACKAGE.JSON MIGRATION

**COMPLETE package.json transformation:**

\`\`\`json
{
  "name": "@elizaos/plugin-[NAME]",
  "version": "1.0.0",
  "description": "ElizaOS plugin for [description]",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "format": "prettier --write \\"src/**/*.{ts,tsx,js,jsx,json,md}\\"",
    "format:check": "prettier --check \\"src/**/*.{ts,tsx,js,jsx,json,md}\\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@elizaos/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "prettier": "^3.0.0",
    "tsup": "8.5.0",
    "typescript": "^5.6.0",
    "vitest": "^1.3.1"
  },
  "keywords": [
    "elizaos",
    "plugin",
    "ai-agent"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/elizaOS/eliza.git",
    "directory": "packages/plugin-[name]"
  },
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  },
  "agentConfig": {
    "name": "[Plugin Name]",
    "description": "[Plugin Description]",
    "version": "1.0.0",
    "author": "[Author]",
    "category": "[Category: social|utility|blockchain|ai|other]",
    "tags": ["tag1", "tag2"],
    "actions": [],
    "providers": [],
    "evaluators": [],
    "services": [],
    "requirements": {
      "environment": ["API_KEY_IF_NEEDED"],
      "optional": ["OPTIONAL_ENV_VAR"]
    }
  }
}
\`\`\`

### STEP 3: TYPESCRIPT CONFIGURATION

**Create tsconfig.json:**

\`\`\`json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts", "**/*.spec.ts"]
}
\`\`\`

**Create tsconfig.build.json:**

\`\`\`json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false
  },
  "exclude": ["**/*.test.ts", "**/*.spec.ts", "src/__tests__/**/*"]
}
\`\`\`

**Create tsup.config.ts:**

\`\`\`typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  target: 'esnext',
  format: ['esm'],
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: true,
  treeshake: true,
  minify: false,
  external: ['@elizaos/core'],
});
\`\`\`

### STEP 4: CORE IMPORT MIGRATIONS

**COMPLETE Import Transformation Table:**

| OLD IMPORT | NEW IMPORT | Notes |
|------------|------------|-------|
| \`import { elizaLogger } from '@elizaos/core'\` | \`import { logger } from '@elizaos/core'\` | Logger renamed |
| \`import { IAgentRuntime } from '@elizaos/core'\` | \`import type { AgentRuntime } from '@elizaos/core'\` | Interface removed |
| \`import { Account } from '@elizaos/core'\` | \`import type { Entity } from '@elizaos/core'\` | Account → Entity |
| \`import { settings } from '@elizaos/core'\` | Remove entirely | Settings deprecated |
| \`import { composeContext } from '@elizaos/core'\` | \`import { composeContext } from '@elizaos/core'\` | Changed signature |
| \`import { generateText } from '@elizaos/core'\` | Remove - use \`runtime.useModel\` | Method moved |
| \`import { generateObject } from '@elizaos/core'\` | Remove - use \`runtime.useModel\` | Method moved |

**Example transformation:**

\`\`\`typescript
// OLD (0.x)
import {
  elizaLogger,
  IAgentRuntime, 
  Account,
  Action,
  composeContext,
  generateText,
  generateObject,
  settings
} from '@elizaos/core';

// NEW (1.x)
import {
  logger,
  type AgentRuntime,
  type Entity,
  type Action,
  composeContext
} from '@elizaos/core';
\`\`\`

### STEP 5: ACTION MIGRATION COMPLETE GUIDE

**OLD Action Structure (0.x):**

\`\`\`typescript
export const myAction: Action = {
  name: "MY_ACTION",
  similes: ["SIMILAR_ACTION"],
  description: "Description",
  validate: async (runtime: IAgentRuntime, message: any) => {
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: any, state: any, options: any, callback: any) => {
    const context = composeContext({
      state,
      template: myTemplate
    });
    
    const response = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL
    });
    
    callback(response);
  }
};
\`\`\`

**NEW Action Structure (1.x):**

\`\`\`typescript
import {
  Action,
  type AgentRuntime,
  type Message,
  type State,
  type ActionResponse,
  composeContext,
  logger
} from '@elizaos/core';

export const myAction: Action = {
  name: "MY_ACTION",
  similes: ["SIMILAR_ACTION"], 
  description: "Description",
  
  validate: async (runtime: AgentRuntime, message: Message, state?: State): Promise<boolean> => {
    // Validation logic - return boolean
    return true;
  },
  
  handler: async (
    runtime: AgentRuntime,
    message: Message,
    state?: State,
    options?: any,
    callback?: any
  ): Promise<boolean> => {
    try {
      // 1. Compose context with NEW composeContext signature
      const context = composeContext({
        state: state || {},
        template: myTemplate, // XML template now
        agentName: runtime.agentName,
        entityName: runtime.getSetting('AGENT_NAME') || 'Agent'
      });
      
      // 2. Use runtime.useModel instead of generateText
      const response = await runtime.useModel({
        messages: [
          {
            role: 'system',
            content: context
          },
          {
            role: 'user', 
            content: message.content.text
          }
        ],
        temperature: 0.7,
        maxTokens: 1000
      });
      
      // 3. Create proper response structure
      const actionResponse: ActionResponse = {
        text: response.text,
        action: 'MY_ACTION',
        source: 'plugin-name'
      };
      
      // 4. Call callback with response
      if (callback) {
        await callback(actionResponse);
      }
      
      return true;
    } catch (error) {
      logger.error('Action failed:', error);
      return false;
    }
  },
  
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Example input" }
      },
      {
        user: "{{agentName}}", 
        content: { text: "Example response", action: "MY_ACTION" }
      }
    ]
  ]
};
\`\`\`

### STEP 6: PROVIDER MIGRATION COMPLETE GUIDE

**OLD Provider Structure (0.x):**

\`\`\`typescript
export const myProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: any, state: any) => {
    return "Provider data";
  }
};
\`\`\`

**NEW Provider Structure (1.x):**

\`\`\`typescript
import {
  Provider,
  type AgentRuntime,
  type Message,
  type State,
  logger
} from '@elizaos/core';

export const myProvider: Provider = {
  name: "MY_PROVIDER", // REQUIRED in 1.x
  description: "Provides data for agent context",
  
  get: async (
    runtime: AgentRuntime,
    message: Message,
    state: State // NON-OPTIONAL in 1.x
  ): Promise<string> => {
    try {
      // Provider logic here
      const data = await fetchProviderData();
      return \`Provider Context: \${data}\`;
    } catch (error) {
      logger.error('Provider failed:', error);
      return '';
    }
  }
};
\`\`\`

### STEP 7: SERVICE MIGRATION COMPLETE GUIDE

**NEW Service Architecture (1.x only):**

\`\`\`typescript
import {
  Service,
  type AgentRuntime,
  type ServiceConfig,
  logger
} from '@elizaos/core';

export class MyService extends Service {
  private config: ServiceConfig;
  private isInitialized = false;
  
  constructor(config?: ServiceConfig) {
    super();
    this.config = config || {};
  }
  
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    try {
      // Service initialization logic
      logger.info('Initializing MyService');
      
      // Setup connections, load config, etc.
      await this.setupConnections();
      
      this.isInitialized = true;
      logger.info('MyService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize MyService:', error);
      throw error;
    }
  }
  
  async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    try {
      // Start service operations
      logger.info('Starting MyService');
      
      // Start listeners, timers, etc.
      await this.startOperations();
      
      logger.info('MyService started successfully');
    } catch (error) {
      logger.error('Failed to start MyService:', error);
      throw error;
    }
  }
  
  async stop(): Promise<void> {
    try {
      logger.info('Stopping MyService');
      
      // Cleanup operations
      await this.cleanup();
      
      this.isInitialized = false;
      logger.info('MyService stopped successfully');
    } catch (error) {
      logger.error('Failed to stop MyService:', error);
      throw error;
    }
  }
  
  private async setupConnections(): Promise<void> {
    // Implementation specific setup
  }
  
  private async startOperations(): Promise<void> {
    // Implementation specific operations
  }
  
  private async cleanup(): Promise<void> {
    // Implementation specific cleanup
  }
}
\`\`\`

### STEP 8: EVALUATOR MIGRATION COMPLETE GUIDE

**OLD Evaluator Structure (0.x):**

\`\`\`typescript
export const myEvaluator: Evaluator = {
  name: "MY_EVALUATOR",
  evaluate: async (runtime: IAgentRuntime, message: any) => {
    // Process message
  }
};
\`\`\`

**NEW Evaluator Structure (1.x):**

\`\`\`typescript
import {
  Evaluator,
  type AgentRuntime,
  type Message,
  type State,
  logger
} from '@elizaos/core';

export const myEvaluator: Evaluator = {
  name: "MY_EVALUATOR",
  description: "Evaluates and processes interactions",
  
  validate: async (
    runtime: AgentRuntime,
    message: Message,
    state?: State
  ): Promise<boolean> => {
    // Return true if this evaluator should process this message
    return true;
  },
  
  handler: async (
    runtime: AgentRuntime,
    message: Message
  ): Promise<void> => {
    try {
      // Process the message and extract information
      logger.debug('Processing message with MyEvaluator');
      
      // Extract entities, relationships, etc.
      const entities = await this.extractEntities(message);
      const relationships = await this.extractRelationships(message);
      
      // Store in memory
      await runtime.memory.create({
        entityId: message.entityId,
        worldId: message.worldId,
        content: JSON.stringify({ entities, relationships }),
        tableName: 'evaluations'
      });
      
    } catch (error) {
      logger.error('Evaluator failed:', error);
    }
  },
  
  examples: [
    {
      input: "Example message",
      output: "Expected evaluation result"
    }
  ]
};
\`\`\`

### STEP 9: MEMORY API MIGRATION

**OLD Memory Operations (0.x):**

\`\`\`typescript
// Remember something
await runtime.memory.remember(userId, roomId, content);

// Recall memories
const memories = await runtime.memory.recall(userId, roomId);

// Search memories
const results = await runtime.memory.search(query);
\`\`\`

**NEW Memory Operations (1.x):**

\`\`\`typescript
// Create memory
await runtime.memory.create({
  entityId: message.entityId,
  worldId: message.worldId,
  content: JSON.stringify(content),
  tableName: 'memories', // Required table name
  embedding: await runtime.embed(content) // Optional embedding
});

// Get memories by entity
const memories = await runtime.memory.getMemories({
  entityId: message.entityId,
  worldId: message.worldId,
  tableName: 'memories',
  count: 10
});

// Search memories by content
const results = await runtime.memory.searchMemories({
  query: searchQuery,
  tableName: 'memories',
  threshold: 0.8,
  count: 5
});

// Create relationship
await runtime.memory.createRelationship({
  entityAId: entity1Id,
  entityBId: entity2Id,
  relationship: 'knows',
  metadata: { confidence: 0.9 }
});

// Get relationships
const relationships = await runtime.memory.getRelationships({
  entityId: message.entityId
});
\`\`\`

### STEP 10: MODEL USAGE MIGRATION

**OLD Model Usage (0.x):**

\`\`\`typescript
import { generateText, generateObject, ModelClass } from '@elizaos/core';

const response = await generateText({
  runtime,
  context,
  modelClass: ModelClass.SMALL
});

const object = await generateObject({
  runtime,
  context,
  schema: MySchema
});
\`\`\`

**NEW Model Usage (1.x):**

\`\`\`typescript
// Text generation
const response = await runtime.useModel({
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ],
  temperature: 0.7,
  maxTokens: 1000,
  model: 'gpt-4' // Optional, uses runtime default
});

// Structured generation with schema
const structuredResponse = await runtime.useModel({
  messages: [
    { role: 'system', content: 'Extract information as JSON' },
    { role: 'user', content: content }
  ],
  responseFormat: {
    type: 'json_object',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'number' }
      },
      required: ['name', 'value']
    }
  }
});

// Embedding generation
const embedding = await runtime.embed(text);
\`\`\`

### STEP 11: TEMPLATE MIGRATION (JSON → XML)

**OLD Template Format (0.x):**

\`\`\`typescript
const myTemplate = {
  "greeting": "Hello {{name}}",
  "response": "I can help you with {{task}}"
};
\`\`\`

**NEW Template Format (1.x):**

\`\`\`typescript
const myTemplate = \`
<template>
  <greeting>Hello {{name}}</greeting>
  <response>I can help you with {{task}}</response>
  <context>
    Current conversation context:
    {{recentMessages}}
    
    Agent capabilities:
    {{capabilities}}
    
    Available actions:
    {{actions}}
  </context>
</template>
\`;
\`\`\`

### STEP 12: COMPLETE TESTING MIGRATION

**Create src/__tests__/test-utils.ts:**

\`\`\`typescript
import { vi } from 'vitest';
import type { AgentRuntime, Message, State, Entity } from '@elizaos/core';

export const createMockRuntime = (): AgentRuntime => ({
  agentName: 'TestAgent',
  
  useModel: vi.fn().mockResolvedValue({
    text: 'Mock response',
    usage: { tokens: 100 }
  }),
  
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  
  memory: {
    create: vi.fn().mockResolvedValue('memory-id'),
    getMemories: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    createRelationship: vi.fn().mockResolvedValue('rel-id'),
    getRelationships: vi.fn().mockResolvedValue([])
  },
  
  getSetting: vi.fn().mockReturnValue('test-value'),
  
  emit: vi.fn(),
  on: vi.fn(),
  
  // Add other required runtime methods
} as unknown as AgentRuntime);

export const createMockMessage = (overrides?: Partial<Message>): Message => ({
  id: 'test-message-id',
  entityId: 'test-entity-id', 
  worldId: 'test-world-id',
  content: {
    text: 'Test message content',
    ...overrides?.content
  },
  timestamp: Date.now(),
  ...overrides
});

export const createMockState = (overrides?: Partial<State>): State => ({
  agentName: 'TestAgent',
  entityName: 'TestEntity',
  recentMessages: [],
  ...overrides
});

export const createMockEntity = (overrides?: Partial<Entity>): Entity => ({
  id: 'test-entity-id',
  name: 'TestEntity', 
  ...overrides
});
\`\`\`

**Action Test Example:**

\`\`\`typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { myAction } from '../actions/my-action';
import { createMockRuntime, createMockMessage, createMockState } from './test-utils';

describe('MyAction', () => {
  let runtime: AgentRuntime;
  let message: Message;
  let state: State;

  beforeEach(() => {
    runtime = createMockRuntime();
    message = createMockMessage({
      content: { text: 'Test action trigger' }
    });
    state = createMockState();
  });

  it('should validate correctly', async () => {
    const isValid = await myAction.validate(runtime, message, state);
    expect(isValid).toBe(true);
  });

  it('should handle request successfully', async () => {
    const callback = vi.fn();
    const result = await myAction.handler(runtime, message, state, {}, callback);
    
    expect(result).toBe(true);
    expect(callback).toHaveBeenCalled();
    expect(runtime.useModel).toHaveBeenCalled();
  });

  it('should handle errors gracefully', async () => {
    runtime.useModel = vi.fn().mockRejectedValue(new Error('API Error'));
    
    const result = await myAction.handler(runtime, message, state);
    expect(result).toBe(false);
  });
});
\`\`\`

### STEP 13: PLUGIN STRUCTURE & EXPORT

**Complete Plugin Definition:**

\`\`\`typescript
import { Plugin } from '@elizaos/core';
import { myAction } from './actions/my-action';
import { myProvider } from './providers/my-provider';
import { myEvaluator } from './evaluators/my-evaluator';
import { MyService } from './services/my-service';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'My ElizaOS plugin',
  
  actions: [myAction],
  providers: [myProvider],
  evaluators: [myEvaluator],
  services: [MyService],
  
  // Plugin lifecycle hooks
  async initialize(runtime: AgentRuntime): Promise<void> {
    // Plugin initialization logic
  },
  
  async start(runtime: AgentRuntime): Promise<void> {
    // Plugin start logic
  },
  
  async stop(runtime: AgentRuntime): Promise<void> {
    // Plugin cleanup logic
  }
};

export default myPlugin;

// Export individual components
export * from './actions/my-action';
export * from './providers/my-provider';
export * from './evaluators/my-evaluator';
export * from './services/my-service';
\`\`\`

### STEP 14: BUILD & VERIFICATION

**Required Commands to Run:**

1. **Install Dependencies:**
   \`\`\`bash
   bun install
   \`\`\`

2. **Type Check:**
   \`\`\`bash
   bunx tsc --noEmit
   \`\`\`

3. **Build:**
   \`\`\`bash
   bun run build
   \`\`\`

4. **Test:**
   \`\`\`bash
   bun test --coverage
   \`\`\`

5. **Format:**
   \`\`\`bash
   bun run format
   \`\`\`

**Success Criteria:**
- ✅ TypeScript compiles with 0 errors
- ✅ Build completes successfully 
- ✅ All tests pass
- ✅ Test coverage ≥ 95%
- ✅ Code is properly formatted
- ✅ Plugin exports correctly

## 🚨 CRITICAL MIGRATION NOTES

### DO NOT:
- Use any stubs or incomplete code
- Skip type annotations
- Leave any TODO comments
- Use old import paths
- Use deprecated APIs
- Skip tests for any component
- Use console.log (use logger instead)

### MUST DO:
- Convert ALL imports to new format
- Update ALL type references
- Implement ALL lifecycle methods for services
- Create comprehensive tests for ALL components
- Achieve 95%+ test coverage
- Use proper error handling everywhere
- Follow TypeScript strict mode
- Use XML templates only
- Implement proper memory operations

### COMMON ERRORS TO AVOID:
1. **Import Errors**: Using old @elizaos imports
2. **Type Errors**: Using Account instead of Entity
3. **API Errors**: Using generateText instead of runtime.useModel
4. **Memory Errors**: Using old memory API
5. **Template Errors**: Using JSON instead of XML
6. **Test Errors**: Not achieving 95% coverage
7. **Build Errors**: TypeScript strict mode violations

This guide provides COMPLETE information for migrating any ElizaOS plugin from 0.x to 1.x. Follow each step carefully and ensure all requirements are met.`;

    const migrationGuide = `# ElizaOS Plugin Migration Guide

Complete migration guide for ElizaOS plugins from 0.x to 1.x version.

## Step 1: Initial Setup

Update package.json with new dependencies and structure.

## Step 2: Import Updates

Replace all old imports with new @elizaos/core paths.

## Step 3: Type Migrations

Update all type references according to the migration table.

## Step 4: Service Integration

Implement proper service architecture with lifecycle methods.

## Step 5: Template Migration

Convert JSON templates to XML format.

## Step 6: Testing Implementation

Create comprehensive test suite with 95%+ coverage.

## Step 7: Final Validation

Ensure all builds pass and tests are green.`;

    const claudeGuide = `# ElizaOS Plugin Migration Guide (0.x to 1.x)

This document contains the migration instructions for upgrading ElizaOS plugins from version 0.x to 1.x.

## Core Migration Requirements

### 1. Import Path Updates

All @elizaos imports must be updated to use the new paths:

\`\`\`typescript
// Old
import { elizaLogger } from '@elizaos/core';
import { AgentRuntime, IAgentRuntime } from '@elizaos/core';
import { Account } from '@elizaos/core';

// New
import { logger } from '@elizaos/core';
import { AgentRuntime } from '@elizaos/core';
import { Entity } from '@elizaos/core';
\`\`\`

### 2. Type Migrations

Update all type references:

- \`Account\` → \`Entity\`
- \`userId\` → \`entityId\`
- \`room\` → \`world\` (agent-side abstraction only)
- \`IAgentRuntime\` → \`AgentRuntime\`

### 3. Service Architecture

Services must now extend the base Service class and implement lifecycle methods:

\`\`\`typescript
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
\`\`\`

### 4. Event System

Implement proper event emission and handling:

\`\`\`typescript
// Emit events
this.runtime.emit('eventName', eventData);

// Listen to events
this.runtime.on('eventName', (data) => {
  // Handle event
});
\`\`\`

### 5. Memory Operations

Update to use new API with table names:

\`\`\`typescript
// Old
await runtime.memory.remember(userId, roomId, content);

// New
await runtime.memory.create({
  entityId,
  worldId,
  content,
  tableName: 'memories',
});
\`\`\`

### 6. Model Usage

Convert generateText to runtime.useModel:

\`\`\`typescript
// Old
const response = await generateText({
  model: 'gpt-4',
  prompt: 'Hello',
});

// New
const response = await runtime.useModel({
  messages: [{ role: 'user', content: 'Hello' }],
});
\`\`\`

### 7. Template Migration

Migrate templates from JSON to XML format:

\`\`\`xml
<!-- Old JSON format -->
{
  "greeting": "Hello {{name}}"
}

<!-- New XML format -->
<template>
  <greeting>Hello {{name}}</greeting>
</template>
\`\`\`

### 8. Testing Requirements

Create comprehensive unit and integration tests:

- Test all actions, providers, evaluators
- Test service initialization and lifecycle
- Test event handling
- Test memory operations
- Test error handling

### 9. Plugin Structure

Ensure proper plugin structure:

\`\`\`typescript
export const myPlugin: Plugin = {
  name: 'plugin-name',
  version: '1.0.0',
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
};
\`\`\`

### 10. Package.json Updates

Update dependencies and scripts:

\`\`\`json
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
\`\`\`

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
- Clear separation of concerns`;

    const readmeGuide = `# ElizaOS Plugin Migration

This directory contains utilities for migrating ElizaOS plugins from v0.x to v1.x.

## Features

- AI-powered automated migration
- Real-time progress tracking
- Gate-based validation system
- Comprehensive error handling
- Cost tracking and optimization

## Usage

\`\`\`bash
elizaos plugins upgrade ./my-plugin --api-key YOUR_KEY
\`\`\`
`;

    // Set all guide content
    this.guides.set('integrated-migration-loop', integratedMigrationLoop);
    this.guides.set('migration_guide', migrationGuide);
    this.guides.set('claude', claudeGuide);
    this.guides.set('readme', readmeGuide);

    logger.debug('Loaded embedded migration guides');
  }

  async loadAllGuides(): Promise<void> {
    // Guides are already loaded in constructor
    return Promise.resolve();
  }

  getGuide(name: string): string | undefined {
    return this.guides.get(name.toLowerCase());
  }

  extractSection(guideName: string, sectionHeader: string): string {
    const guide = this.getGuide(guideName);
    if (!guide) return '';

    // Extract section between headers
    const lines = guide.split('\n');
    let inSection = false;
    let sectionContent: string[] = [];
    let sectionLevel = 0;

    for (const line of lines) {
      const headerMatch = line.match(/^(#+)\s+(.+)$/);

      if (headerMatch) {
        const level = headerMatch[1].length;
        const header = headerMatch[2];

        if (header.includes(sectionHeader) && !inSection) {
          inSection = true;
          sectionLevel = level;
          continue;
        } else if (inSection && level <= sectionLevel) {
          // End of section
          break;
        }
      }

      if (inSection) {
        sectionContent.push(line);
      }
    }

    return sectionContent.join('\n').trim();
  }

  buildPromptWithGuides(template: string, requiredGuides: string[] = []): string {
    let prompt = template;

    // Replace guide placeholders
    for (const guideName of requiredGuides) {
      const guide = this.getGuide(guideName);
      if (guide) {
        const placeholder = `{{${guideName.toUpperCase()}}}`;
        prompt = prompt.replace(placeholder, guide);
      }
    }

    return prompt;
  }
}
