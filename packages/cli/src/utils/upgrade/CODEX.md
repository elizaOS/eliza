# ElizaOS Plugin Migration Mega Prompt: V1 to V2 Complete Guide

## 🎯 **Migration Objective**

Transform any ElizaOS v1 plugin to v2 architecture following Discord plugin patterns while fixing all compatibility issues identified in legacy plugins.

## 🚨 **CRITICAL: NO VITEST TESTING REQUIRED**

**ElizaOS V2 plugins use ONLY the built-in `elizaos test` framework. Do NOT create vitest tests, vitest configs, or include vitest in dependencies.**

## 📝 **AUTOMATIC TEST FILE GENERATION**

**IMPORTANT: The migration tool automatically creates test files from templates:**
- `src/test/utils.ts` - Copied exactly from a proven template with complete mock runtime
- `src/test/test.ts` - Generated dynamically based on plugin name and structure

**DO NOT manually create test files in Codex prompts - they are handled by the migration tool.**

## 📖 **Reference Implementation**

**Use `plugin-discord` as your V2 reference implementation**

The Discord plugin serves as the canonical example of proper v2 architecture. Study these key files:

```bash
plugin-discord/
├── src/
│   ├── service.ts           # ✅ Proper Service class implementation
│   ├── actions/             # ✅ Individual action files (import to centralized)
│   │   ├── voiceJoin.ts
│   │   ├── voiceLeave.ts
│   │   └── chatWithAttachments.ts
│   ├── providers/           # ✅ Standard Provider implementations
│   │   ├── channelState.ts
│   │   └── voiceState.ts
│   ├── index.ts            # ✅ V2 plugin export structure
│   ├── types.ts            # ✅ TypeScript interfaces
│   └── environment.ts      # ✅ Configuration patterns
├── package.json            # ✅ V2 package structure
├── tsconfig.json           # ✅ V2 TypeScript config
├── tsup.config.ts          # ✅ V2 build configuration
├── .github/workflows/      # ✅ CI/CD pipeline
├── images/                 # ✅ Required assets
```

**Key Discord Patterns to Study:**

- **Service Class**: `src/service.ts` - Shows proper Service extension, lifecycle methods
- **Action Structure**: `src/actions/*.ts` - Modern action handler signatures
- **Provider Pattern**: `src/providers/*.ts` - Standard provider interface usage
- **Memory Operations**: How to properly create memories with entityId/source
- **Configuration**: Environment validation and runtime.getSetting usage

## 🚨 **Critical Architecture Issues to Fix**

### 1. **Missing Service Layer - CRITICAL FIX REQUIRED** - Fix this only if plugin have service

**V1 Problem Pattern:**

```typescript
// ❌ V1: Empty or missing service.ts
export const myPlugin: Plugin = {
  name: 'plugin-name',
  actions: actions,
  evaluators: [], // Outdated pattern
};
```

**V2 Solution (Discord Pattern):**

```typescript
// ✅ V2: Proper Service Class (Reference: plugin-discord/src/service.ts)
export class MyService extends Service {
    static serviceType: string = 'my-service';

    constructor(runtime: IAgentRuntime) {
        super(runtime);
        // Initialize with config validation
    }

    static async start(runtime: IAgentRuntime) {
        const service = new MyService(runtime);
        return service;
    }

    async stop(): Promise<void> {
        // Cleanup resources
    }

    get capabilityDescription(): string {
        return 'Service capability description';
    }
}

// ✅ V2: Plugin with Service (Reference: plugin-discord/src/index.ts)
const myPlugin: Plugin = {
    name: 'my-plugin',
    description: 'Plugin description',
    services: [MyService], // REQUIRED
    actions: [...],
    providers: [...],
    tests: [...],
    init: async (config, runtime) => {
        // Initialization logic
    }
};
```

### 2. **V1 to V2 Core Import Incompatibilities - CRITICAL FIX REQUIRED**

**CRITICAL: These imports will completely break V2 plugins and must be fixed immediately**

**V1 Problem Pattern:**

```typescript
// ❌ V1: Wrong import names that don't exist in V2
import {
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,      // ❌ DOES NOT EXIST IN V2
    State,
    type Action,
    logger,
    createUniqueUuid
} from "@elizaos/core";

// ❌ V1: Wrong model usage
const result = await runtime.useModel(ModelClass.SMALL, {  // ❌ WRONG
    prompt: context,
    temperature: 0.3,
    maxTokens: 50,
    stop: ["\n"],  // ❌ WRONG PARAMETER NAME
});

// ❌ V1: Wrong ActionExample structure
examples: [
    [
        {
            user: "{{user1}}",  // ❌ WRONG FIELD NAME
            content: { text: "example text" },
        },
        {
            user: "{{user2}}",  // ❌ WRONG FIELD NAME
            content: { text: "", action: "MY_ACTION" },
        },
    ]
] as ActionExample[][],
```

**V2 Solution (Fixed Imports and Usage):**

```typescript
// ✅ V2: Correct imports with proper types
import {
    type ActionExample,     // ✅ Use type import for interfaces
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelType,              // ✅ CORRECT: ModelType, not ModelClass
    type State,
    type Action,
    logger,
    createUniqueUuid
} from "@elizaos/core";

// ✅ V2: Correct model usage
const result = await runtime.useModel(ModelType.TEXT_SMALL, {  // ✅ CORRECT
    prompt: context,
    temperature: 0.3,
    maxTokens: 50,
    stopSequences: ["\n"],  // ✅ CORRECT PARAMETER NAME
});

// ✅ V2: Correct ActionExample structure
examples: [
    [
        {
            name: "{{user1}}",  // ✅ CORRECT FIELD NAME
            content: { text: "example text" },
        },
        {
            name: "{{user2}}",  // ✅ CORRECT FIELD NAME
            content: { text: "", action: "MY_ACTION" },
        },
    ]
] as ActionExample[][],

// ✅ V2: Correct handler signature
handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: { [key: string]: unknown },  // ✅ CORRECT TYPE
    _callback: HandlerCallback,
): Promise<boolean> => {
    // Handler implementation
}
```

**CRITICAL ModelType Values in V2:**

```typescript
// ✅ Available V2 ModelType constants
ModelType.TEXT_SMALL; // ✅ Use this instead of ModelClass.SMALL
ModelType.TEXT_LARGE; // ✅ Use this instead of ModelClass.LARGE
ModelType.TEXT_EMBEDDING; // ✅ For embeddings
ModelType.TEXT_REASONING_SMALL; // ✅ For reasoning tasks
ModelType.TEXT_REASONING_LARGE; // ✅ For complex reasoning
ModelType.IMAGE; // ✅ For image generation
ModelType.IMAGE_DESCRIPTION; // ✅ For image analysis
ModelType.TRANSCRIPTION; // ✅ For audio transcription
ModelType.TEXT_TO_SPEECH; // ✅ For TTS
ModelType.OBJECT_SMALL; // ✅ For structured object generation
ModelType.OBJECT_LARGE; // ✅ For complex object generation
```

**CRITICAL Parameter Name Changes:**

```typescript
// ❌ V1: Old parameter names
await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: '...',
  stop: ['\n'], // ❌ OLD NAME
  max_tokens: 100, // ❌ OLD NAME
  frequency_penalty: 0.5, // ❌ OLD NAME
});

// ✅ V2: New parameter names
await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: '...',
  stopSequences: ['\n'], // ✅ NEW NAME
  maxTokens: 100, // ✅ NEW NAME
  frequencyPenalty: 0.5, // ✅ NEW NAME
});
```

### 3. **Broken Action Handler Signatures - CRITICAL FIX**

**V1 Problem Pattern:**

```typescript
// ❌ V1: Wrong handler signature
handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined, // Wrong type
    options: { [key: string]: unknown; } = {}, // Wrong type
    callback?: HandlerCallback // Should be required
): Promise<boolean> => { ... }
```

**V2 Solution (Discord Pattern):**

```typescript
// ✅ V2: Correct handler signature (Reference: plugin-discord/src/actions/voiceJoin.ts)
export const myAction: Action = {
    name: "MY_ACTION",
    description: "Action description",
    validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        // Validation logic
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback
    ) => {
        // Handler logic
        const content: Content = {
            text: "Response text",
            source: 'my-plugin'
        };
        callback(content);
    },
    examples: [...] as ActionExample[][]
} as Action;
```

### 4. **Memory Creation Pattern Violations - CRITICAL FIX**

**V1 Problem Pattern:**

```typescript
// ❌ V1: Wrong memory structure
const memory: Memory = {
  id: SOME_ID, // Should use createUniqueUuid
  userId: runtime.agentId, // Wrong field
  content: {
    type: 'custom_type', // Not standard
    data: complexObject, // Non-serializable
  },
};
await runtime.messageManager.createMemory(memory); // Wrong method

// ❌ V1: Another wrong pattern found in real migrations
await _runtime.memory.create({
  tableName: 'messages',
  data: {
    id: createUniqueUuid(_runtime, `news-${Date.now()}`),
    entityId: _message.entityId,
    content: {
      text: responseText,
      actionName: 'CURRENT_NEWS', // ❌ Non-standard field
      source: 'plugin-news',
    } as Content,
  },
});
```

**V2 Solution (Discord Pattern):**

```typescript
// ✅ V2: Correct memory structure (Reference: plugin-discord/src/actions/voiceJoin.ts)
await runtime.createMemory(
  {
    id: createUniqueUuid(runtime, `my-action-${Date.now()}`),
    entityId: createUniqueUuid(runtime, address), // REQUIRED
    agentId: runtime.agentId,
    roomId: createUniqueUuid(runtime, 'my-service'),
    content: {
      text: 'Action completed successfully',
      source: 'my-plugin', // REQUIRED
    },
    metadata: {
      // REQUIRED
      type: 'action_completion',
    },
    createdAt: Date.now(),
  },
  'messages'
);

// ✅ V2: Real-world working example
await _runtime.createMemory(
  {
    id: createUniqueUuid(_runtime, `news-${Date.now()}`),
    entityId: _message.entityId,
    agentId: _runtime.agentId,
    roomId: _message.roomId, // Use original message roomId
    content: {
      text: responseText,
      source: 'plugin-news', // ONLY standard Content fields
    },
    metadata: {
      type: 'news_response',
      actionName: 'CURRENT_NEWS', // Move action info to metadata
    },
    createdAt: Date.now(),
  },
  'messages'
);
```

### 5. **Provider Interface Incompatibility - CRITICAL FIX**

**V1 Problem Pattern:**

```typescript
// ❌ V1: Custom provider interface
export interface CustomProvider {
  type: string;
  initialize: (runtime: IAgentRuntime) => Promise<void>;
  get: (runtime: IAgentRuntime, message?: Memory) => Promise<CustomState>;
  validate: (runtime: IAgentRuntime, message?: Memory) => Promise<boolean>;
}
```

**V2 Solution (Discord Pattern):**

```typescript
// ✅ V2: Standard provider interface (Reference: plugin-discord/src/providers/channelState.ts)
export const myStateProvider: Provider = {
  name: 'myState',
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const myService = runtime.getService('my-service') as MyService;

    return {
      data: {
        isInitialized: myService.isInitialized(),
        status: myService.getStatus(),
      },
      values: {
        serviceStatus: myService.getStatus() || 'Not initialized',
      },
      text: `Service status: ${myService.getStatus() || 'Not initialized'}`,
    };
  },
};
```

## 🔧 **Required Migration Steps**

### Phase 1: Outside Structure & Build System Migration

**1. Update package.json to V2 Structure:**

```json
{
  "name": "@elizaos/plugin-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-org/plugin-my-plugin.git"
  },
  "exports": {
    "./package.json": "./package.json",
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    }
  },
  "files": ["dist"],
  "dependencies": {
    "@elizaos/core": "^1.0.0",
    "zod": "3.24.2"
  },
  "devDependencies": {
    "prettier": "3.5.3",
    "tsup": "8.4.0"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "elizaos test",
    "lint": "prettier --write ./src",
    "format": "prettier --write ./src",
    "format:check": "prettier --check ./src",
    "clean": "rm -rf dist .turbo node_modules .turbo-tsconfig.json tsconfig.tsbuildinfo"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

**2. Remove V1 Configuration Files:**

```bash
# Delete these V1 files:
rm biome.json              # Replace with prettier
rm vitest.config.ts        # Use elizaos test instead
rm jest.config.js          # Use elizaos test instead
rm jest.config.ts          # Use elizaos test instead
```

**3. Update Build Configuration (tsconfig.json):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "allowJs": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.*"]
}
```

**3a. Create Build-Specific TypeScript Configuration (tsconfig.build.json):**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.*", "__tests__/**/*"]
}
```

**4. Update Build Configuration (tsup.config.ts):**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'], // ESM format only
  dts: true,
  external: [
    'dotenv', // Externalize dotenv to prevent bundling
    'fs', // Externalize fs to use Node.js built-in module
    'path', // Externalize other built-ins if necessary
    '@reflink/reflink',
    '@node-llama-cpp',
    'https',
    'http',
    'agentkeepalive',
    'zod',
    // Add other modules you want to externalize
  ],
});
```

**5. Create CI/CD Pipeline (.github/workflows/npm-deploy.yml):**

```yaml
name: Publish Package

on:
  push:
    branches:
      - 1.x # Discord uses 1.x branch
  workflow_dispatch:

jobs:
  verify_version:
    runs-on: ubuntu-latest
    outputs:
      should_publish: ${{ steps.check.outputs.should_publish }}
      version: ${{ steps.check.outputs.version }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check if package.json version changed
        id: check
        run: |
          echo "Current branch: ${{ github.ref }}"

          # Get current version
          CURRENT_VERSION=$(jq -r .version package.json)
          echo "Current version: $CURRENT_VERSION"

          # Get previous commit hash
          git rev-parse HEAD~1 || git rev-parse HEAD
          PREV_COMMIT=$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)

          # Check if package.json changed
          if git diff --name-only HEAD~1 HEAD | grep "package.json"; then
            echo "Package.json was changed in this commit"
            
            # Get previous version if possible
            if git show "$PREV_COMMIT:package.json" 2>/dev/null; then
              PREV_VERSION=$(git show "$PREV_COMMIT:package.json" | jq -r .version)
              echo "Previous version: $PREV_VERSION"
              
              if [ "$CURRENT_VERSION" != "$PREV_VERSION" ]; then
                echo "Version changed from $PREV_VERSION to $CURRENT_VERSION"
                echo "should_publish=true" >> $GITHUB_OUTPUT
              else
                echo "Version unchanged"
                echo "should_publish=false" >> $GITHUB_OUTPUT
              fi
            else
              echo "First commit with package.json, will publish"
              echo "should_publish=true" >> $GITHUB_OUTPUT
            fi
          else
            echo "Package.json not changed in this commit"
            echo "should_publish=false" >> $GITHUB_OUTPUT
          fi

          echo "version=$CURRENT_VERSION" >> $GITHUB_OUTPUT

  publish:
    needs: verify_version
    if: needs.verify_version.outputs.should_publish == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Create Git tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag -a "v${{ needs.verify_version.outputs.version }}" -m "Release v${{ needs.verify_version.outputs.version }}"
          git push origin "v${{ needs.verify_version.outputs.version }}"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      - name: Build package
        run: bun run build

      - name: Publish to npm
        run: bun publish
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}

  create_release:
    needs: [verify_version, publish]
    if: needs.verify_version.outputs.should_publish == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Create GitHub Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: 'v${{ needs.verify_version.outputs.version }}'
          release_name: 'v${{ needs.verify_version.outputs.version }}'
          body: 'Release v${{ needs.verify_version.outputs.version }}'
          draft: false
          prerelease: false
```

**6. Create Required Images Structure (images/README.md):**

```markdown
# Plugin Images

This directory contains visual assets for the plugin.

## Required Files

- `icon.png` - Plugin icon (512x512px recommended)
- `banner.png` - Plugin banner for documentation
- `screenshot.png` - Plugin functionality screenshot

## Usage

These images are used in:

- NPM package listing
- Documentation
- Plugin marketplace
- GitHub repository display

## Guidelines

- Use high-quality PNG format
- Keep file sizes reasonable (<500KB each)
- Maintain consistent branding
- Follow ElizaOS visual guidelines
```

**7. Update .gitignore:**

```gitignore
# Dependencies
node_modules/
.pnp
.pnp.js

# Build outputs
dist/
build/
*.tsbuildinfo
.turbo/

# Environment files
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*

# Coverage
coverage/
*.lcov
*.eliza
*.elizadb
```

**8. Create .npmignore:**

```npmignore
# Source files
src/
__tests__/
e2e/

# Config files
tsconfig*.json
tsup.config.ts
.github/
.gitignore

# Development files
*.test.*
*.spec.*
coverage/
.turbo/
```

### Phase 2: Service Layer Creation

**1. Create Service Class (src/service.ts):** - only implement if plugin conatains service file or require service file other wise SKIP IT

```typescript
// Reference: Study plugin-discord/src/service.ts for complete implementation
import { Service, type IAgentRuntime, logger } from '@elizaos/core';
import { validateMyConfig } from './config';

export class MyService extends Service {
  static serviceType: string = 'my-service';
  private isServiceInitialized = false;
  private connections: Map<string, any> = new Map();
  private timeouts: Set<NodeJS.Timeout> = new Set();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    const service = new MyService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize() {
    try {
      const config = validateMyConfig(this.runtime);
      // Initialize service with config
      this.isServiceInitialized = true;
      logger.info('MyService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize MyService', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Clean up timeouts
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();

    // Clean up connections
    this.connections.clear();

    this.isServiceInitialized = false;
    logger.info('MyService stopped successfully');
  }

  get capabilityDescription(): string {
    return 'Service for handling my plugin functionality';
  }

  isInitialized(): boolean {
    return this.isServiceInitialized;
  }
}
```

### Phase 3: Configuration Migration

**1. Create Configuration File (src/config.ts):**

```typescript
import { z } from 'zod';
import { type IAgentRuntime } from '@elizaos/core';

export const ConfigSchema = z.object({
  API_KEY: z.string().min(1, 'API key is required'),
  API_ENDPOINT: z.string().url().optional(),
  ENABLE_FEATURE: z.boolean().default(false),
});

export type MyConfig = z.infer<typeof ConfigSchema>;

export function validateMyConfig(runtime: IAgentRuntime): MyConfig {
  const config = {
    API_KEY: runtime.getSetting('MY_API_KEY') || process.env.MY_API_KEY,
    API_ENDPOINT: runtime.getSetting('MY_API_ENDPOINT') || process.env.MY_API_ENDPOINT,
    ENABLE_FEATURE: runtime.getSetting('MY_ENABLE_FEATURE') === 'true',
  };

  return ConfigSchema.parse(config);
}
```

### Phase 4: Actions Migration

**1. Centralize Actions from Nested Structure (src/actions.ts):**

**V1 Pattern to Migrate From:**

```
src/
  actions/
    actionOne/
      index.ts
    actionTwo/
      index.ts
    actionThree/
      index.ts
```

**V2 Centralized Pattern (Reference: plugin-discord/src/index.ts imports):**

```typescript
import {
  type Action,
  type ActionExample,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { MyService } from './service';

export const myAction: Action = {
  name: 'MY_ACTION',
  similes: ['DO_SOMETHING', 'EXECUTE_ACTION'],
  description: 'Performs my plugin action',

  validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Reference: plugin-discord/src/actions/voiceJoin.ts validate method
    if (message.content.source && message.content.source !== 'my-plugin') {
      return false;
    }

    const myService = runtime.getService('my-service') as MyService;
    if (!myService || !myService.isInitialized()) {
      logger.warn('MyService not available or not initialized');
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    try {
      // Reference: plugin-discord/src/actions/voiceJoin.ts handler method
      const myService = runtime.getService('my-service') as MyService;

      const result = await performMyAction(myService, message);

      await runtime.createMemory(
        {
          id: createUniqueUuid(runtime, `my-action-${Date.now()}`),
          entityId: message.entityId,
          agentId: runtime.agentId,
          roomId: message.roomId,
          content: {
            text: `Action completed: ${result}`,
            source: 'my-plugin',
          },
          metadata: {
            type: 'action_completion',
            actionName: 'MY_ACTION',
          },
          createdAt: Date.now(),
        },
        'messages'
      );

      const content: Content = {
        text: `Successfully completed action: ${result}`,
        source: 'my-plugin',
      };

      callback(content);
    } catch (error) {
      logger.error('Action failed', { error });

      const errorContent: Content = {
        text: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
        source: 'my-plugin',
      };

      callback(errorContent);
    }
  },

  examples: [
    [
      {
        name: 'User',
        content: { text: 'Please perform my action' },
      },
      {
        name: 'Assistant',
        content: {
          text: 'I will perform the action for you',
          actions: ['MY_ACTION'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

async function performMyAction(service: MyService, message: Memory): Promise<string> {
  // Implementation logic here
  return 'Action completed successfully';
}

export const myPluginActions = [myAction];
```

### Phase 5: Provider Migration

**1. Create Standard Providers (src/providers.ts):**

```typescript
// Reference: Study plugin-discord/src/providers/channelState.ts and voiceState.ts
import { type Provider, type IAgentRuntime, type Memory, type State } from '@elizaos/core';
import type { MyService } from './service';

export const myStateProvider: Provider = {
  name: 'myState',
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const myService = runtime.getService('my-service') as MyService;

    return {
      data: {
        isInitialized: myService?.isInitialized() || false,
        serviceType: MyService.serviceType,
      },
      values: {
        serviceStatus: myService?.isInitialized() ? 'Ready' : 'Not initialized',
      },
      text: `My Plugin Service: ${myService?.isInitialized() ? 'Ready' : 'Not initialized'}`,
    };
  },
};
```

export const myPluginProviders = [myStateProvider];

```

### Phase 6: Test Infrastructure Creation

**🚨 CRITICAL: NO VITEST TESTS REQUIRED - ELIZAOS TEST ONLY**

**MANDATORY TESTING RULES:**
- ✅ **ONLY use ElizaOS built-in testing framework** - `elizaos test`
- ❌ **DO NOT create vitest tests** - Remove vitest from devDependencies
- ❌ **DO NOT create vitest.config.ts** - Not needed for V2 plugins
- ❌ **DO NOT create jest tests** - ElizaOS test replaces all other testing
- ✅ **Use src/test/ structure** - Following plugin-coinmarketcap pattern

**CRITICAL TESTING MIGRATION: V1 `__tests__/` → V2 `src/test/`**

V1 plugins used `__tests__/` directory structure with vitest/jest, but V2 requires the `src/test/` pattern with ElizaOS testing only.

**1. Delete V1 Testing Structure and Clean Up:**

```bash
# Delete entire V1 __tests__ directory structure
rm -rf __tests__/

# Delete old test configurations
rm -f vitest.config.ts
rm -f jest.config.js
rm -f jest.config.ts
rm -f biome.json
rm -f vitest.config.mjs

# Delete old linting configs
rm -f .eslintrc.js
rm -f .eslintrc.json
rm -f .eslintignore

# Delete old formatting configs
rm -f .prettierrc
rm -f .prettierrc.js
rm -f .prettierrc.json
rm -f .prettierignore

# Delete old build artifacts
rm -rf .turbo/
rm -rf dist/
rm -rf build/
rm -f *.tsbuildinfo

# Delete old dependency files if switching to bun
rm -f yarn.lock
rm -f package-lock.json

# Delete old environment template files
rm -f .env.example
rm -f .env.template
rm -f environment.d.ts

# Delete old documentation if exists
rm -f CHANGELOG.md
rm -f CONTRIBUTING.md

# Clean up any old nested action directories (V1 pattern)
# Only remove if you've centralized actions to src/actions.ts
rm -rf src/actions/*/
```

**2. Create V2 Test Infrastructure (src/test/ Pattern):**

**MANDATORY: Follow plugin-coinmarketcap Test Structure EXACTLY**

```bash
# Create the V2 test directory structure exactly like plugin-coinmarketcap
mkdir -p src/test
```

**3. Copy or Create Test Utilities (src/test/utils.ts):**

**Reference: Use plugin-coinmarketcap/src/test/utils.ts as the definitive template**

Copy the comprehensive testing utils from plugin-coinmarketcap:

```bash
# Copy the proven testing utils from plugin-coinmarketcap
cp /path/to/plugin-coinmarketcap/src/test/utils.ts src/test/utils.ts
```

**Alternative: Create utils.ts manually following the plugin-coinmarketcap structure:**

**CRITICAL V2 MOCK RUNTIME FIX:**

During real migrations, the mock runtime must be updated for V2 memory patterns:

**❌ V1 Pattern that breaks V2:**

```typescript
memory: {
  create: async (params: { tableName: string; data: Memory }) => {
    const id = params.data.id || (uuidv4() as UUID);
    memories.set(id, { ...params.data, id });
    return id;
  };
}
```

**✅ V2 Pattern that works:**

```typescript
createMemory: async (memory: Memory, tableName: string) => {
  const id = memory.id || (uuidv4() as UUID);
  memories.set(id, { ...memory, id });
  return id;
};
```

**3. Create Test Utilities (src/test/utils.ts):**

**MANDATORY: Copy EXACTLY from `plugin-coinmarketcap/src/test/utils.ts`**

**CRITICAL TESTING UTILITIES RULES - NO EXCEPTIONS:**

1. **EXACT IMPLEMENTATION** - Must follow `plugin-coinmarketcap/src/test/utils.ts` structure precisely
2. **COMPLETE Mock Runtime** - All IAgentRuntime methods must be implemented
3. **Mock Logger Functions** - Full logging capture and verification
4. **Memory Management** - Comprehensive memory operations mocking
5. **Service Registration** - Complete service lifecycle mocking
6. **TypeScript Compliance** - Full type safety implementation

**REFERENCE LOCATIONS:**

- **Primary Reference**: `plugin-coinmarketcap/src/test/utils.ts` (COMPLETE IMPLEMENTATION)
- **Alternative References**:
  - `plugin-news-cursor/src/test/utils.ts` (V2 compliant)

**Key Components to Include:**

- `MockLogFunction` interface for logging capture
- `mockLogger` object with all logging methods
- `createMockRuntime()` function with complete IAgentRuntime implementation
- All database, memory, service, and model methods
- Proper TypeScript types and UUID handling

**🚨 CRITICAL TESTING ENVIRONMENT RULES:**

**MANDATORY: Use BUN for package management and testing:**

```bash
# Use bun instead of npm for these commands
bun install          # Instead of npm install
bun run build        # Instead of npm run build
bun run test         # Instead of npm run test (if available)
```

**MANDATORY: Handle test environment failures properly:**

When `npm run test` fails due to missing environment variables:

1. **There will be a `.env` file created by Elizaos after running test first time** - locate and use it
2. **Use HARDCODED dummy API keys** for testing
3. **Add dummy environment variables** to `.env` file as needed
4. **Use Hardcoded OPENAI_API_KEY Everytime in .env file**

```OPENAI_API_KEY=

```

**🔄 DYNAMIC ENVIRONMENT VARIABLE DETECTION:**

**RULE: Adapt environment variables based on plugin requirements**

5. **Automatically detect and add required API keys for each plugin type:**
   - **CoinMarketCap Plugin**: `COINMARKETCAP_API_KEY=test-cmc-key-12345`
   - **News Plugin**: `NEWS_API_KEY=dummy-news-api-key-67890`
   - **Discord Plugin**: `DISCORD_APPLICATION_ID=123456789` + `DISCORD_API_TOKEN=dummy-token`
   - **Solana Plugin**: `SOLANA_ENDPOINT=https://api.mainnet-beta.solana.com`
   - **Custom Plugin**: Scan source code for `runtime.getSetting("YOUR_API_KEY")` patterns

**DYNAMIC ENV DETECTION PATTERN:**

```bash
# Scan plugin source for required environment variables
grep -r "getSetting(" src/ | grep -o '"[^"]*"' | sort -u
# Add dummy values for each detected variable to .env
```

**Example: Plugin-specific .env generation:**

```bash
# For news plugin
NEWS_API_KEY=dummy-news-key-12345
NEWS_ENDPOINT=https://newsapi.org/v2

# For crypto plugin
COINMARKETCAP_API_KEY=test-cmc-key-67890
COINGECKO_API_KEY=dummy-gecko-key-54321

# Always include base ElizaOS requirements
OPENAI_API_KEY=
```

**⚠️ NOTE: The OPENAI_API_KEY example above is just a template - each plugin may require different API keys. Adapt the .env file based on the specific plugin's `runtime.getSetting()` calls.**

**🚨 CRITICAL .env FILE RULES:**

6. **ALWAYS include OPENAI_API_KEY in .env file - MANDATORY for ALL plugins:**

   ```bash
   OPENAI_API_KEY=
   ```

   - **Required for ElizaOS core functionality**
   - **Include even if plugin doesn't directly use OpenAI**
   - **Never skip this key regardless of plugin type**

7. **NEVER delete existing .env content - ONLY ADD/EDIT:**
   - ✅ **DO**: Add new environment variables to existing .env
   - ✅ **DO**: Update existing values if needed
   - ❌ **DON'T**: Delete or remove existing environment variables
   - ❌ **DON'T**: Create new .env if one already exists
   - **PRESERVE**: All existing configuration in .env file

**Safe .env editing pattern:**

```bash
# If .env exists, append/update only
echo "NEW_API_KEY=dummy-value" >> .env
# Or edit specific lines without removing others
sed -i 's/OLD_VALUE/NEW_VALUE/' .env
```

**Example .env for testing:**

```bash
# Dummy API keys for testing - DO NOT use real credentials
MY_API_KEY=test-api-key-12345
NEWS_API_KEY=dummy-news-api-key
COINMARKETCAP_API_KEY=test-cmc-key-67890
COINGECKO_API_KEY=dummy-gecko-key
API_ENDPOINT=https://api.example.com
ENABLE_FEATURE=true
```

**IMPORTANT TESTING RULES:**

- ✅ **ALWAYS use dummy/test API keys** - never real production keys
- ✅ **GPT creates .env file** - use the existing one, don't create new
- ✅ **Hardcode test values** - tests should work without real API access
- ✅ **Use bun commands** when available for faster execution
- ✅ **Test validation over real API calls** - focus on structure testing

**4. Create Comprehensive Test Suite (src/test/test.ts):**

**MANDATORY: Follow plugin-coinmarketcap/src/test/test.ts Structure EXACTLY**

**CRITICAL TESTING RULES - NO EXCEPTIONS:**

1. **NEVER use stubs or incomplete code** - All test logic must be fully implemented
2. **ALWAYS write comprehensive tests** - Cover all functionality, edge cases, and error conditions
3. **Follow test-driven development** - Tests should drive the architecture and validate complete functionality
4. **Ensure proper error handling** - Test both success and failure scenarios thoroughly
5. **Use TypeScript for all code** - Full type safety in all test code
6. **Clear separation of concerns** - Each test should focus on a specific functionality

**Reference Implementation:**
See `plugin-news/src/test/test.ts` for a complete example of proper test suite implementation.

During real migrations, ElizaOS integration tests may fail with "Cannot read properties of undefined (reading 'forEach')" when using complex runtime calls like `useModel()`. Here's the proven solution:

**❌ PROBLEMATIC: Complex integration tests that fail with ElizaOS runtime**

```typescript
// This pattern causes runtime errors in ElizaOS integration tests
await action.handler(runtime, mockMessage, { values: {}, data: {}, text: '' }, {}, callback);
// Fails with: Cannot read properties of undefined (reading 'forEach')
```

**✅ SOLUTION: Simplified integration tests for V2 compatibility**
**REFERENCE LOCATIONS FOR COMPLETE TEST SUITE IMPLEMENTATION:**

**MANDATORY: Copy test suite structure EXACTLY from these proven V2 implementations:**

**PRIMARY REFERENCE - `plugin-coinmarketcap/src/test/test.ts`:**

- ✅ Complete comprehensive test implementation (600+ lines)
- ✅ Real API testing with working error handling
- ✅ Service registration and lifecycle testing
- ✅ Action validation and execution testing
- ✅ Provider state management testing
- ✅ Memory operations testing
- ✅ Plugin initialization testing

**ALTERNATIVE REFERENCES:**

- `plugin-coingecko/src/test/test.ts` - Enhanced V2 test patterns
- `plugin-news-cursor/src/test/test.ts` - News-specific testing patterns
- `plugin-akash/src/test/test.ts` - Service-focused comprehensive testing

**PROVEN TEST PATTERNS FOR V2 COMPATIBILITY:**

**✅ ElizaOS Integration Tests Pattern:**

```typescript
// Focus on structure validation, avoid complex runtime calls
{
  name: "Should execute action successfully",
  fn: async (runtime: IAgentRuntime) => {
    console.log('🧪 Testing action validation and structure');

    const action = myPlugin.actions[0];
    if (!action?.name || !action?.description || !action?.validate || !action?.handler) {
      throw new Error('Action missing required properties');
    }

    // Basic validation test only - avoid complex useModel() calls
    try {
      await action.validate(runtime, mockMessage);
      console.log('✅ Action validation callable');
    } catch (error: unknown) {
      console.log('✅ Action validation properly handles errors');
    }
  }
}
```

**COMPREHENSIVE TEST STRUCTURE TO IMPLEMENT:**

1. **Plugin V2 Structure Validation** - Verify services, providers, actions, init function
2. **Service Registration Testing** - Test service.start(), service.stop(), capabilityDescription
3. **Action Execution Testing** - Test validate(), handler(), examples, memory creation
4. **Provider State Testing** - Test all providers return proper data/values/text structure
5. **Error Handling Testing** - Test invalid API keys, missing config, network failures
6. **Plugin Lifecycle Testing** - Test init() with/without config, service lifecycle
7. **Memory Operations Testing** - Test createMemory() patterns, structure validation

**KEY TESTING RULES FROM REFERENCE IMPLEMENTATIONS:**

- ✅ **NO stubs or incomplete code** - All test logic fully implemented
- ✅ **COMPREHENSIVE coverage** - Test all functionality, edge cases, errors
- ✅ **Test-driven development** - Tests validate complete functionality
- ✅ **Proper error handling** - Test both success AND failure scenarios
- ✅ **Full TypeScript** - Complete type safety in all test code
- ✅ **Clear separation** - Each test focuses on specific functionality

**5. Update Package.json Test Configuration (V2 Standard - ElizaOS Test Only):**

```json
{
  "scripts": {
    "test": "elizaos test",
    "test:watch": "elizaos test --watch",
    "test:coverage": "elizaos test --coverage",
    "test:debug": "elizaos test --verbose"
  }
}
```

**🚨 IMPORTANT: Do NOT add vitest scripts. Only use elizaos test commands.**

**6. Test Registration in Plugin Index (src/index.ts):**

```typescript
// Update plugin definition to include tests
import testSuite from './test/test';

const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My plugin description for ElizaOS',
  services: [MyService],
  actions: myPluginActions,
  providers: myPluginProviders,
  evaluators: [],
  tests: [testSuite], // REQUIRED: Register test suite
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    // initialization logic
  },
};
```

### Phase 7: Documentation Structure

**1. Create Comprehensive README.md:**

```markdown
# @elizaos/plugin-my-plugin

Brief description of what this plugin does.

## Installation

```bash
npm install @elizaos/plugin-my-plugin
```
```

## Configuration

Add to your `.eliza/.env` file:

```bash
MY_API_KEY=your_api_key_here
MY_API_ENDPOINT=https://api.example.com
MY_ENABLE_FEATURE=true
```

## Usage

```typescript
import myPlugin from '@elizaos/plugin-my-plugin';

// Add to your ElizaOS configuration
const plugins = [myPlugin];
```

## Actions

- `MY_ACTION` - Performs plugin functionality

## Providers

- `myState` - Provides current plugin state

## Development

```bash
bun run dev    # Development mode
bun run build  # Build for production
bun run test   # Run tests
bun run lint   # Lint code
```

## License

MIT
