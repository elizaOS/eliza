# Plugin Quick Starter

A minimal backend-only plugin template for ElizaOS. This template provides a clean starting point for creating simple plugins without frontend complexity.

## Overview

This quick-starter template is ideal for:

- Backend-only plugins
- Simple API integrations
- Services and providers
- Actions without UI components
- Lightweight extensions

## Structure

```
plugin-quick-starter/
├── src/
│   ├── __tests__/          # Test directory
│   │   ├── e2e/            # E2E tests
│   │   │   ├── plugin-quick-starter.e2e.ts
│   │   │   └── README.md
│   │   ├── plugin.test.ts  # Component tests
│   │   └── test-utils.ts   # Test utilities
│   ├── plugin.ts           # Main plugin implementation (exports tests)
│   └── index.ts            # Plugin export
├── scripts/
│   └── install-test-deps.js # Test dependency installer
├── tsup.config.ts          # Build configuration
├── tsconfig.json           # TypeScript config
├── package.json            # Minimal dependencies
└── README.md               # This file
```

## Getting Started

1. **Create your plugin:**

   ```bash
   elizaos create my-plugin
   # Select: Plugin
   # Select: Quick Plugin (Backend Only)
   ```

2. **Navigate to your plugin:**

   ```bash
   cd my-plugin
   ```

3. **Install dependencies:**

   ```bash
   bun install
   ```

4. **Start development:**
   ```bash
   bun run dev
   ```

## Key Features

### Minimal Dependencies

- Only essential packages (`@elizaos/core`, `zod`)
- No frontend frameworks or build tools
- Fast installation and builds

### Comprehensive Testing

- Component tests with Bun test runner for unit testing
- E2E tests with ElizaOS test runner for integration testing
- Quick test execution with focused test suites

### Backend Focus

- API routes for server-side functionality
- Services for state management
- Actions for agent capabilities
- Providers for contextual data

## Plugin Components

### Actions

Define agent capabilities:

```typescript
const myAction: Action = {
  name: 'MY_ACTION',
  description: 'Description of what this action does',
  validate: async (runtime, message, state) => {
    // Validation logic
    return true;
  },
  handler: async (runtime, message, state, options, callback) => {
    // Action implementation
    return { success: true, data: {} };
  },
};
```

### Services

Manage plugin state:

```typescript
export class MyService extends Service {
  static serviceType = 'my-service';

  async start() {
    // Initialize service
  }

  async stop() {
    // Cleanup
  }
}
```

### Providers

Supply contextual information:

```typescript
const myProvider: Provider = {
  name: 'MY_PROVIDER',
  description: 'Provides contextual data',
  get: async (runtime, message, state) => {
    return {
      text: 'Provider data',
      values: {},
      data: {},
    };
  },
};
```

### API Routes

Backend endpoints:

```typescript
routes: [
  {
    name: 'api-endpoint',
    path: '/api/endpoint',
    type: 'GET',
    handler: async (req, res) => {
      res.json({ data: 'response' });
    },
  },
];
```

## Development Commands

```bash
# Start in development mode with hot reload
bun run dev

# Start in production mode
bun run start

# Build the plugin
bun run build

# Run tests
bun test

# Format code
bun run format
```

## Testing

ElizaOS employs a dual testing strategy:

1. **Component Tests** (`src/__tests__/*.test.ts`)

   - Run with Bun's native test runner
   - Fast, isolated tests using mocks
   - Perfect for TDD and component logic

2. **E2E Tests** (`src/__tests__/e2e/*.e2e.ts`)
   - Run with ElizaOS custom test runner
   - Real runtime with actual database (PGLite)
   - Test complete user scenarios

### Test Structure

```
src/
  __tests__/              # All tests live inside src
    *.test.ts            # Component tests (use Bun test runner)
    e2e/                 # E2E tests (use ElizaOS test runner)
      plugin-quick-starter.e2e.ts  # E2E test suite
      README.md          # E2E testing documentation
  plugin.ts              # Export tests here: tests: [QuickStarterPluginTestSuite]
```

### Running Tests

```bash
# Run all tests (component + e2e)
elizaos test

# Component tests only
elizaos test component
# or
bun test

# E2E tests only
elizaos test e2e
```

### Writing Component Tests

```typescript
import { describe, it, expect } from 'bun:test';

describe('My Plugin', () => {
  it('should work correctly', () => {
    expect(true).toBe(true);
  });
});
```

## Publishing

1. Update `package.json` with your plugin details
2. Build your plugin: `bun run build`
3. Publish: `elizaos publish`

## When to Use Quick Starter

Use this template when you need:

- ✅ Backend-only functionality
- ✅ Simple API integrations
- ✅ Lightweight plugins
- ✅ Fast development cycles
- ✅ Minimal dependencies

Consider the full plugin-starter if you need:

- ❌ React frontend components
- ❌ Complex UI interactions
- ❌ E2E testing with Cypress
- ❌ Frontend build pipeline

## License

This template is part of the ElizaOS project.
