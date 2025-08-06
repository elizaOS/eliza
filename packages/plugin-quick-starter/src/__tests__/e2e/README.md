# E2E Tests for Plugin Quick Starter

This directory contains end-to-end tests for the ElizaOS plugin quick starter template.

## ElizaOS Testing Philosophy

ElizaOS employs a dual testing strategy:

1. **Component Tests** (`src/__tests__/*.test.ts`)

   - Run with Bun's native test runner
   - Fast, isolated tests using mocks
   - Perfect for TDD and component logic
   - Command: `bun test`

2. **E2E Tests** (`src/__tests__/e2e/*.e2e.ts`)
   - Run with ElizaOS custom test runner
   - Real runtime with actual database (PGLite)
   - Test complete user scenarios
   - Command: `elizaos test --type e2e`

## Overview

E2E tests run in a real ElizaOS runtime environment, allowing you to test your plugin's behavior as it would work in production. The quick starter template focuses on minimal, essential functionality to help you get started quickly.

## Test Structure

- **QuickStarterPluginTestSuite** - Main test suite containing all e2e tests
  - `plugin_should_be_loaded` - Verifies plugin is loaded correctly
  - `should_have_quick_action_registered` - Checks action registration
  - `quick_action_should_execute_successfully` - Tests basic action execution
  - `quick_provider_should_provide_data` - Tests provider functionality
  - `quick_service_should_be_available` - Tests service availability (optional)
  - `plugin_should_integrate_with_agent_correctly` - Tests agent integration
  - `memory_operations_should_work_with_plugin` - Tests memory system integration
  - `plugin_should_handle_errors_gracefully` - Tests error handling

## Integration with Plugin

E2E tests are integrated directly into your plugin without the need for an intermediate export file:

```typescript
// src/plugin.ts
import { QuickStarterPluginTestSuite } from './__tests__/e2e/plugin-quick-starter.e2e';

export const quickPlugin: Plugin = {
  name: 'plugin-quick-starter',
  // ... other properties
  tests: [QuickStarterPluginTestSuite], // Direct import!
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

## Quick Starter Specifics

The quick starter template is designed for rapid prototyping with minimal boilerplate. Tests focus on:

1. **Basic Functionality**: Core plugin features work correctly
2. **Simple Integration**: Plugin integrates with the runtime
3. **Essential Operations**: Memory and message processing work
4. **Error Resilience**: Plugin handles errors gracefully

## Implementation Details

1. **Direct Import**: Tests are imported directly from the e2e test file
2. **Plugin Integration**: The test suite is added to the plugin's `tests` array
3. **Test Discovery**: The ElizaOS test runner automatically finds and executes tests
4. **Runtime Access**: Each test receives a real runtime instance with full access to:
   - Plugin actions, providers, and services
   - Agent character configuration
   - Database and model access

## Writing New Tests

When extending the quick starter plugin, add corresponding e2e tests:

```typescript
{
  name: 'my_new_feature_test',
  fn: async (runtime) => {
    // Test your new feature
    const feature = runtime.getFeature('my-feature');
    if (!feature) {
      throw new Error('My feature not loaded');
    }

    // Test feature behavior
    const result = await feature.doSomething();
    if (!result.success) {
      throw new Error('Feature failed: ' + result.error);
    }

    console.log('✓ My feature works correctly');
  }
}
```

## Best Practices

1. **Keep It Simple**: Quick starter tests should remain minimal and focused
2. **Test Essentials**: Focus on core functionality that every plugin needs
3. **Clear Messages**: Use descriptive error messages for easy debugging
4. **Fast Feedback**: Tests should run quickly for rapid development
5. **Incremental Testing**: Add tests as you add features to your plugin

## Troubleshooting

### Tests not running?

- Ensure tests are exported in `plugin.ts`
- Check that the plugin name matches in tests
- Verify the ElizaOS test runner is up to date

### Tests failing?

- Check runtime initialization
- Verify all required services are available
- Ensure test data doesn't conflict with other tests

## Next Steps

1. Run the existing tests to ensure your setup works
2. Modify tests as you customize the plugin
3. Add new tests for your custom functionality
4. Use TDD: write tests first, then implement features
5. Keep tests focused and maintainable
