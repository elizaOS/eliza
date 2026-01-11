# Bootstrap Plugin Test Suite

## Overview

This directory contains a comprehensive test suite for the Eliza Bootstrap Plugin. The tests cover all major components of the plugin including actions, providers, evaluators, services, and event handling logic.

**IMPORTANT: There is NO mockRuntime. All tests use REAL AgentRuntime instances with PGLite for database operations.**

## Testing Philosophy

elizaOS follows a "no mock" testing philosophy:

- **All tests use real AgentRuntime instances** - This ensures tests validate actual behavior
- **PGLite provides in-memory databases** - Fast, isolated test execution without external dependencies
- **Tests verify real database operations** - State changes are persisted and can be verified

## Test Utilities

The test suite includes utilities in `test-utils.ts`:

### Runtime Creation

- `createTestRuntime(options?)`: Creates a real `AgentRuntime` with PGLite database. Use for all tests.

- `createTestRuntimeWithCleanup(options?)`: Creates runtime with automatic cleanup function.

- `setupActionTestAsync(options?)`: Async setup for action tests - returns runtime, test data, and cleanup.

### Data Creation Utilities

- `createTestMemory(overrides?)`: Creates test Memory objects (data structure, not mock).

- `createTestState(overrides?)`: Creates test State objects (data structure, not mock).

- `createTestRoom(overrides?)`: Creates test Room objects (data structure, not mock).

- `createTestCharacter(overrides?)`: Creates test Character configurations.

### Helper Utilities

- `cleanupTestRuntime(runtime)`: Properly closes and cleans up a test runtime.

- `waitFor(condition, timeout?, interval?)`: Waits for a condition to be true.

- `retry(fn, maxRetries?, baseDelay?)`: Retries a function with exponential backoff.

- `createUUID()`: Creates a UUID for testing.

## Best Practices

1. **Use Real Runtimes**: Always use `createTestRuntime()` or `createTestRuntimeWithCleanup()`.

2. **Clean Up**: Always call cleanup in `afterEach` to prevent test pollution.

3. **Test Real Behavior**: Verify actual database state changes, not mock method calls.

4. **Use vi.spyOn for Verification**: If you need to verify method calls, use `vi.spyOn()` on the real runtime.

## Usage

Run all tests:

```bash
npx vitest packages/typescript/src/bootstrap/__tests__
```

Run specific test file:

```bash
npx vitest packages/typescript/src/bootstrap/__tests__/actions.test.ts
```

Run tests in watch mode:

```bash
npx vitest --watch packages/typescript/src/bootstrap/__tests__
```

## Common Test Patterns

### Basic Action Test with Real Runtime

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestRuntimeWithCleanup, createTestMemory, createTestState } from "./test-utils";
import { myAction } from "../actions";
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";

describe("My Action", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;

  beforeEach(async () => {
    const result = await createTestRuntimeWithCleanup();
    runtime = result.runtime;
    cleanup = result.cleanup;

    // Create test room in the database
    testRoomId = await runtime.createRoom({
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should validate correctly", async () => {
    const message = createTestMemory({ roomId: testRoomId });
    const state = createTestState();

    const isValid = await myAction.validate(runtime, message, state);

    expect(isValid).toBe(true);
  });

  it("should handle action and persist data", async () => {
    const message = createTestMemory({
      roomId: testRoomId,
      content: { text: "test message" },
    });
    const state = createTestState();
    const callback = vi.fn();

    const result = await myAction.handler(runtime, message, state, {}, callback);

    expect(result.success).toBe(true);

    // Verify data was actually persisted
    const memories = await runtime.getMemories({
      roomId: testRoomId,
      count: 10,
    });
    expect(memories.length).toBeGreaterThan(0);
  });
});
```

### Testing Providers with Real Runtime

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRuntimeWithCleanup, createTestMemory, createTestState } from "./test-utils";
import { myProvider } from "../providers/myProvider";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";

describe("My Provider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testRoomId: UUID;

  beforeEach(async () => {
    const result = await createTestRuntimeWithCleanup();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testRoomId = await runtime.createRoom({
      name: "Test Room",
      source: "test",
      type: ChannelType.GROUP,
    });

    // Create test data in the database
    await runtime.createMemory({
      roomId: testRoomId,
      entityId: "test-entity-id",
      agentId: runtime.agentId,
      content: { text: "stored data" },
    }, "messages");
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should return provider result from real data", async () => {
    const message = createTestMemory({ roomId: testRoomId });
    const state = createTestState();

    const result = await myProvider.get(runtime, message, state);

    expect(result).toBeDefined();
    expect(result.text).toContain("stored data");
  });
});
```

### Testing Services with Real Runtime

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRuntimeWithCleanup } from "./test-utils";
import { MyService } from "../services/myService";
import type { IAgentRuntime } from "@elizaos/core";

describe("My Service", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let service: MyService;

  beforeEach(async () => {
    const result = await createTestRuntimeWithCleanup();
    runtime = result.runtime;
    cleanup = result.cleanup;

    service = new MyService();
    await service.start(runtime);
  });

  afterEach(async () => {
    await service.stop();
    await cleanup();
  });

  it("should initialize correctly", () => {
    expect(service.capabilityDescription).toBeDefined();
  });

  it("should process data with real runtime", async () => {
    const result = await service.processData("test input");
    expect(result).toBeDefined();
  });
});
```

### Using vi.spyOn for Method Verification

If you need to verify that specific runtime methods were called:

```typescript
it("should call useModel with correct parameters", async () => {
  // Spy on the real runtime method
  const useModelSpy = vi.spyOn(runtime, "useModel").mockResolvedValue("yes");

  const message = createTestMemory({ roomId: testRoomId });
  const state = createTestState();

  await myAction.handler(runtime, message, state, {}, vi.fn());

  expect(useModelSpy).toHaveBeenCalledWith(
    ModelType.TEXT_SMALL,
    expect.objectContaining({ prompt: expect.any(String) })
  );
});
```

## Migration from Mock Tests

If you have existing tests using `createMockRuntime()`, migrate them as follows:

### Before (with mocks - DEPRECATED):

```typescript
// ❌ DON'T: Use mock runtime
const mockRuntime = createMockRuntime({
  getSetting: vi.fn().mockReturnValue("value"),
});
```

### After (with real runtime):

```typescript
// ✅ DO: Use real runtime with spies
const { runtime, cleanup } = await createTestRuntimeWithCleanup();
vi.spyOn(runtime, "getSetting").mockReturnValue("value");
// ... test ...
await cleanup();
```

## Skipping Tests Without Database

If `@elizaos/plugin-sql` is not available, tests should be skipped:

```typescript
beforeEach(async () => {
  try {
    const result = await createTestRuntimeWithCleanup();
    runtime = result.runtime;
    cleanup = result.cleanup;
  } catch {
    // plugin-sql not available
    runtime = null;
  }
});

it("should work with real runtime", async () => {
  if (!runtime) {
    console.warn("Skipping test - @elizaos/plugin-sql not available");
    return;
  }
  // ... test code ...
});
```
