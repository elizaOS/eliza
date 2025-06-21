# Bootstrap Plugin Test Suite

## Overview

This directory contains a comprehensive test suite for the Eliza Bootstrap Plugin. The tests cover all major components of the plugin including actions, providers, evaluators, services, and event handling logic.

## Key Features

1. **Standardized Test Utilities**: The `test-utils.ts` file provides the canonical foundation for all tests with robust mock factories and type definitions.

2. **Reusable Test Setup**: The `setupActionTest()` function creates a standardized test environment with consistent mock objects across all test files.

3. **Comprehensive Coverage**: Tests cover actions, providers, evaluators, services, and event handling with proper error handling and edge cases.

4. **Type Safety**: Strong typing with proper mocking of required interfaces ensures type safety throughout the test suite.

## Test Utilities

The test suite includes a robust set of utilities in `test-utils.ts`:

- `createMockRuntime()`: Creates a comprehensive mock of the `IAgentRuntime` interface. **This is the canonical implementation that should be used across the entire codebase.**

- `createMockMemory()`: Creates standardized mock Memory objects for testing.

- `createMockState()`: Creates standardized mock State objects for testing.

- `createMockService()`: Creates standardized mock Service objects for testing.

- `setupActionTest()`: Creates a complete test environment with all necessary mocks for testing actions, providers, evaluators, and other components.

## Best Practices

1. **Use Standard Test Setup**: Always use `setupActionTest()` when possible for consistent test environments.

2. **Prefer Existing Mock Functions**: Use the exported mock creation functions rather than creating custom mocks.

3. **Type Safety**: Maintain strong typing with proper casting when necessary.

4. **DRY Principle**: Avoid duplicating test setup logic - reuse the standard test setup functions.

5. **Canonical Implementation**: The `createMockRuntime()` function in this directory is the canonical implementation and should be used across all packages.

## Usage

Run all tests:

```bash
npx vitest run packages/plugin-bootstrap/__tests__
```

Run specific test file:

```bash
npx vitest run packages/plugin-bootstrap/__tests__/actions.test.ts
```

Run tests in watch mode:

```bash
npx vitest watch packages/plugin-bootstrap/__tests__
```

## Common Test Patterns

### Testing Actions

```typescript
describe('My Action', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let callbackFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Use the standard setup function
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
    callbackFn = setup.callbackFn;
  });

  it('should validate correctly', async () => {
    // Test implementation
  });
});
```

### Testing Providers

```typescript
describe('My Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    // Use the standard setup function with custom state
    const setup = setupActionTest({
      stateOverrides: {
        values: {
          customValue: 'test',
        },
      },
    });
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
  });

  it('should provide correct data', async () => {
    // Test implementation
  });
});
```
