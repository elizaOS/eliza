# Project Starter Tests

This document provides information about the testing approach for the Project Starter plugin.

## Test Structure

The project uses a standardized testing approach that leverages core test utilities for consistency across the Eliza ecosystem.

### Core Test Utilities

The tests reuse core testing functionality from `@elizaos/core` through a set of utilities in the `__tests__/utils/core-test-utils.ts` file:

- `runCoreActionTests` - Validates action structure and functionality
- `runCoreModelTests` - Tests model behavior with various parameters
- `documentTestResult` - Records test results for debugging and documentation
- `createMockRuntime` - Creates a standardized runtime for testing
- `createMockMessage` - Creates test messages for action testing
- `createMockState` - Creates test state objects

### Test Categories

The test suite covers:

1. **Actions** - Testing the HELLO_WORLD action and action utilities
2. **Models** - Testing TEXT_SMALL and TEXT_LARGE model implementations
3. **Plugin Structure** - Validating the overall plugin structure
4. **Routes** - Testing API routes
5. **Integration** - End-to-end plugin functionality
6. **File Structure** - Ensuring proper package organization
7. **Configuration** - Testing configuration handling

## Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- actions.test.ts

# Run tests in watch mode
npm test -- --watch
```

## Test Implementation

### Action Tests

The action tests use the core action test utilities to validate:

- Action structure compliance
- Action validation functionality
- Action handler behavior
- Action formatting utilities

Example from `actions.test.ts`:

```typescript
// Run core tests on all plugin actions
it('should pass core action tests', () => {
  if (plugin.actions) {
    const coreTestResults = runCoreActionTests(plugin.actions);
    expect(coreTestResults).toBeDefined();
    // ...
  }
});
```

### Model Tests

The model tests validate:

- Model interface compliance
- Handling of various parameters
- Response formatting
- Error handling

Example from `models.test.ts`:

```typescript
it('should run core tests for TEXT_SMALL model', async () => {
  if (plugin.models && plugin.models[ModelType.TEXT_SMALL]) {
    const results = await runCoreModelTests(
      ModelType.TEXT_SMALL,
      plugin.models[ModelType.TEXT_SMALL]
    );
    // ...
  }
});
```

## Writing New Tests

When adding new features, follow these guidelines:

1. Use the core test utilities where possible
2. Structure tests in a consistent manner
3. Document test results using `documentTestResult`
4. Use the `createMockRuntime` for standardized testing

Example:

```typescript
it('should test my new feature', async () => {
  const runtime = createMockRuntime();
  const message = createMockMessage('Test message');
  const state = createMockState();

  const result = await myFeature(runtime, message, state);

  expect(result).toBeTruthy();
  documentTestResult('My feature test', result);
});
```

## Logs and Documentation

All tests use the Eliza logger for consistent reporting:

```typescript
logger.info(`TEST: ${testName}`);
logger.error(`ERROR: ${error.message}`);
```

## Debugging

To view detailed logs during test runs:

```bash
# Run with detailed logging
DEBUG=eliza:* npm test
```
