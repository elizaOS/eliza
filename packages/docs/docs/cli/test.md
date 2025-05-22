---
sidebar_position: 6
title: Test Command
description: Run and manage tests for ElizaOS projects and plugins
keywords: [testing, component tests, e2e tests, Vitest, test runner, development]
image: /img/cli.jpg
---

# Test Command

The `test` command allows you to run tests for your ElizaOS projects, plugins, and agents. It helps ensure your implementations work correctly before deployment.

## Usage

```bash
elizaos test [options] [command]
```

## Subcommands

| Command     | Description                                |
| ----------- | ------------------------------------------ |
| `component` | Run component tests using Vitest           |
| `e2e`       | Run end-to-end runtime tests               |
| `all`       | Run both component and e2e tests (default) |

## Options

| Option              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `-p, --port <port>` | Server port for e2e tests                               |
| `-n, --name <name>` | Filter tests by name (matches file names or test names) |
| `--skip-build`      | Skip building before running tests                      |

## Test Structure

ElizaOS tests are organized in two main categories:

1. **Component Tests** (`__tests__/`): Focused on testing individual components and their integrations, run with Vitest.
2. **End-to-End Tests** (`e2e/`): Testing full runtime behavior of agents and plugins.

### Component Tests

Component tests are written using Vitest and located in the `__tests__/` directory:

```typescript
// Example component test (__tests__/plugin.test.ts)
import { describe, it, expect } from 'vitest';
import { myPlugin } from '../src';

describe('Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(myPlugin.name).toBe('my-plugin');
  });

  it('should include required config variables', () => {
    expect(myPlugin.config).toHaveProperty('API_KEY');
  });
});
```

### End-to-End Tests

E2E tests verify runtime behavior and are located in the `e2e/` directory:

```typescript
// Example e2e test (e2e/plugin.test.ts)
export class PluginTestSuite implements TestSuite {
  name = 'plugin_test_suite';
  tests = [
    {
      name: 'example_test',
      fn: async (runtime) => {
        // Test implementation
        if (runtime.character.name !== 'Eliza') {
          throw new Error('Expected character name to be "Eliza"');
        }
      },
    },
    {
      name: 'should_have_action',
      fn: async (runtime) => {
        // Another test
        const actionExists = plugin.actions.some((a) => a.name === 'EXAMPLE_ACTION');
        if (!actionExists) {
          throw new Error('Example action not found in plugin');
        }
      },
    },
  ],
};

export default new PluginTestSuite();
```

## Running Tests

### Basic Test Execution

Run all tests in the current project:

```bash
# Navigate to your project
cd my-agent-project

# Run all tests (component and e2e)
elizaos test

# Run only component tests
elizaos test component

# Run only e2e tests
elizaos test e2e
```

### Filtering Tests

Filter tests by name:

```bash
# Run component tests with "auth" in the name or file path
elizaos test component --name auth

# Run e2e tests with "database" in the name
elizaos test e2e --name database
```

### Skipping Build

To skip the build step when running tests:

```bash
# Run all tests without building first
elizaos test --skip-build

# Run component tests without building
elizaos test component --skip-build
```

## Component Test Output

Component tests (powered by Vitest) produce output like:

```
 PASS  __tests__/plugin.test.ts (4 tests)
   Plugin Configuration
     ✓ should have correct plugin metadata
     ✓ should include required config variables
   Plugin Service
     ✓ should start the service
     ✓ should handle required actions

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  1.45s
```

## E2E Test Output

E2E tests produce output showing test results:

```
Running test suite: plugin_test_suite
  Running test: example_test
  Running test: should_have_action

Test Summary: 2 passed, 0 failed, 0 skipped
```

## Writing Tests

### Component Tests

Component tests typically verify units and their integrations:

```typescript
// Example component test
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { myPlugin } from '../src';

describe('Service Registration', () => {
  const mockRuntime = {
    registerService: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register the service with runtime', async () => {
    await myPlugin.init({ API_KEY: 'test-key' })(mockRuntime);
    expect(mockRuntime.registerService).toHaveBeenCalledWith(
      'my-service',
      expect.objectContaining({
        start: expect.any(Function),
        stop: expect.any(Function),
      })
    );
  });
});
```

### E2E Tests

E2E tests verify the functionality in a real runtime environment:

```typescript
// Example e2e test
export default {
  name: 'database_tests',
  tests: [
    {
      name: 'data_persistence',
      fn: async (runtime) => {
        // Test implementation
        const service = runtime.getService('database');

        // Create data
        await service.insert('test', { key: 'value' });

        // Verify retrieval
        const result = await service.get('test');
        if (result.key !== 'value') {
          throw new Error('Data not persisted correctly');
        }
      },
    },
  ],
};
```

## Test Hooks for E2E Tests

ElizaOS e2e tests support hooks for setup and teardown:

```typescript
export default {
  name: 'database_tests',
  beforeAll: async (runtime) => {
    // Setup test database
    await runtime.db.migrate();
  },
  afterAll: async (runtime) => {
    // Clean up test database
    await runtime.db.clean();
  },
  beforeEach: async (runtime, test) => {
    // Setup before each test
    console.log(`Running test: ${test.name}`);
  },
  afterEach: async (runtime, test) => {
    // Cleanup after each test
  },
  tests: [
    // Test cases
  ],
};
```

## Test Utilities

ElizaOS provides test utilities to simplify writing tests:

```typescript
// Using test utilities for component tests
import { createMockRuntime, createMockService } from './test-utils';

describe('Plugin Integration', () => {
  it('should interact with other services', async () => {
    const mockDatabaseService = createMockService('database');
    const mockRuntime = createMockRuntime({
      services: {
        database: mockDatabaseService,
      },
    });

    // Test implementation
  });
});
```

## Examples

### Testing a Complete Project

```bash
# Run all tests
elizaos test

# Run with specific options
elizaos test --port 4000 --skip-build
```

### CI/CD Integration

```bash
# Run tests in CI environment
elizaos test
```

## Troubleshooting

### Component Tests Not Found

If component tests aren't being discovered:

```bash
# Check your file naming pattern
# Files should be in __tests__/ directory with .test.ts extension

# Try running with more specific name filter
elizaos test component --name specificTestName
```

### E2E Tests Failing Due to Port Conflicts

If e2e tests fail due to port conflicts:

```bash
# Specify a different port
elizaos test e2e --port 4000
```

### TypeScript Errors

If TypeScript compilation is failing:

```bash
# Build the project first
elizaos project build

# Then run tests with skip-build
elizaos test --skip-build
```

## Related Commands

- [`dev`](./dev.md): Run your project in development mode
- [`start`](./start.md): Start your project in production mode
