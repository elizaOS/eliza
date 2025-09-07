# E2E Tests for Plugin Starter

This directory contains end-to-end tests for the ElizaOS plugin starter template.

## ElizaOS Testing Philosophy

ElizaOS employs a dual testing strategy:

1. **Component Tests** (`src/__tests__/*.test.ts`)

   - Run with Bun's native test runner
   - Fast, isolated tests using mocks
   - Perfect for TDD and component logic
   - Command: `bun test`

2. **E2E Tests** (`src/__tests__/e2e/*.ts`)
   - Run with ElizaOS custom test runner
   - Real runtime with actual database (PGLite)
   - Test complete user scenarios
   - Command: `elizaos test --type e2e`

## Overview

E2E tests run in a real ElizaOS runtime environment, allowing you to test your plugin's behavior as it would work in production. Unlike component tests, E2E tests provide access to a fully initialized runtime with all services, actions, and providers available.

## Test Structure

- **StarterPluginTestSuite** - Main test suite containing all e2e tests
  - `example_test` - Verifies plugin is loaded correctly
  - `should_have_hello_world_action` - Checks action registration
  - `hello_world_action_test` - **Key test**: Simulates asking the agent to say "hello" and validates the response contains "hello world"
  - `hello_world_provider_test` - Tests provider functionality
  - `starter_service_test` - Tests service lifecycle

## Integration with Plugin

E2E tests are integrated directly into your plugin without the need for an intermediate export file:

```typescript
// src/plugin.ts
import { StarterPluginTestSuite } from './__tests__/e2e/plugin-starter.e2e';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  // ... other properties
  tests: [StarterPluginTestSuite], // Direct import!
};
```

## Running Tests

```bash
# Run all tests (component + e2e)
elizaos test

# Run only e2e tests (slower, full integration)
elizaos test --type e2e

# Run only component tests (fast, for TDD)
bun test
# or
elizaos test --type component
```

## Implementation Details

1. **Direct Import**: Tests are imported directly from the e2e test file - no intermediate export file needed
2. **Plugin Integration**: The test suite is added to the plugin's `tests` array
3. **Test Discovery**: The ElizaOS test runner automatically finds and executes tests from the plugin's `tests` array
4. **Runtime Access**: Each test receives a real runtime instance with full access to:
   - Plugin actions, providers, and services
   - Agent character configuration
   - Database and model access

## Known Issues

- The test runner may look for tests on other plugins (e.g., @elizaos/plugin-sql) instead of the current plugin
- TypeScript validation in the test runner may flag type issues that don't affect actual functionality

## Writing New Tests

See the comprehensive documentation at the top of `plugin-starter.e2e.ts` for detailed instructions on adding new tests.
