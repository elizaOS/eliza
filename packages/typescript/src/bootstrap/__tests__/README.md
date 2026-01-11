<!-- TODO: Try-catch review completed 2026-01-11. This is a README file. No code to review. -->

# Bootstrap Plugin Test Suite

## Overview

This directory contains a comprehensive test suite for the Eliza Bootstrap Plugin. The tests cover all major components of the plugin including actions, providers, evaluators, services, and event handling logic.

## Test Utilities

The test suite includes utilities in `test-utils.ts`:

### Runtime Creation

- `createMockRuntime(overrides?)`: Creates an `IAgentRuntime` with all methods mocked via `vi.fn()`. Use for unit tests.

- `createTestRuntime(options?)`: Creates a real `AgentRuntime` with a mocked database adapter. Use for integration tests.

- `setupActionTest(options?)`: Quick setup for action tests - returns runtime, message, state, and callback.

### Data Creation Utilities

- `createTestMemory(overrides?)` / `createMockMemory(overrides?)`: Creates test Memory objects.

- `createTestState(overrides?)` / `createMockState(overrides?)`: Creates test State objects.

- `createMockRoom(overrides?)`: Creates test Room objects.

- `createTestCharacter(overrides?)`: Creates test Character configurations.

- `createMockDatabaseAdapter(agentId?)`: Creates an in-memory database adapter for testing.

### Helper Utilities

- `cleanupTestRuntime(runtime)`: Properly closes and cleans up a test runtime.

- `waitFor(condition, timeout?, interval?)`: Waits for a condition to be true.

- `createUUID()`: Creates a UUID for testing.

### Type Aliases

- `MockRuntime`: Type alias for `IAgentRuntime` (for backward compatibility).

## Best Practices

1. **Use `IAgentRuntime` Type**: Always type your test runtime as `IAgentRuntime`.

2. **Choose the Right Utility**:
   - Unit tests → `createMockRuntime()` or `setupActionTest()`
   - Integration tests → `createTestRuntime()`

3. **Clean Up**: Always call `cleanupTestRuntime()` in `afterEach` for integration tests.

4. **Use vi.spyOn for Verification**: If you need to verify method calls, use `vi.spyOn()` on the runtime.

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

### Quick Action Test with setupActionTest

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { setupActionTest } from "./test-utils";
import { myAction } from "../actions";

describe("My Action", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should validate correctly", async () => {
    const { mockRuntime, mockMessage, mockState } = setupActionTest();

    const isValid = await myAction.validate(mockRuntime, mockMessage, mockState);

    expect(isValid).toBe(true);
  });

  it("should handle action with custom overrides", async () => {
    const { mockRuntime, mockMessage, mockState, callbackFn } = setupActionTest({
      runtimeOverrides: {
        getSetting: vi.fn().mockReturnValue("custom-value"),
      },
      messageOverrides: {
        content: { text: "custom message" },
      },
    });

    const result = await myAction.handler(
      mockRuntime,
      mockMessage,
      mockState,
      {},
      callbackFn
    );

    expect(result.success).toBe(true);
    expect(callbackFn).toHaveBeenCalled();
  });
});
```

### Unit Testing with createMockRuntime

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockRuntime, createTestMemory, createTestState } from "./test-utils";
import { myAction } from "../actions";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

describe("My Action", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(() => {
    runtime = createMockRuntime({
      getSetting: vi.fn().mockReturnValue("test-api-key"),
    });
    message = createTestMemory({ content: { text: "test message" } });
    state = createTestState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should validate correctly", async () => {
    const isValid = await myAction.validate(runtime, message, state);
    expect(isValid).toBe(true);
  });

  it("should call runtime methods", async () => {
    await myAction.handler(runtime, message, state);

    expect(runtime.createMemory).toHaveBeenCalled();
  });
});
```

### Integration Testing with createTestRuntime

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRuntime, cleanupTestRuntime, createTestMemory } from "./test-utils";
import type { IAgentRuntime } from "@elizaos/core";

describe("My Provider Integration", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should work with real runtime", async () => {
    const roomId = await runtime.createRoom({
      name: "test-room",
      source: "test",
      type: "GROUP",
    });

    await runtime.createMemory({
      roomId,
      entityId: "test-entity-id",
      agentId: runtime.agentId,
      content: { text: "test message" },
    }, "messages");

    const memories = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 10,
    });

    expect(memories.length).toBeGreaterThan(0);
  });
});
```

### Testing Providers

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockRuntime, createTestMemory, createTestState } from "./test-utils";
import { myProvider } from "../providers/myProvider";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

describe("My Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(() => {
    runtime = createMockRuntime();
    message = createTestMemory();
    state = createTestState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return provider result", async () => {
    const result = await myProvider.get(runtime, message, state);

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });

  it("should handle custom data", async () => {
    runtime.getMemories = vi.fn().mockResolvedValue([
      createTestMemory({ content: { text: "stored data" } }),
    ]);

    const result = await myProvider.get(runtime, message, state);

    expect(result.text).toContain("stored data");
  });
});
```

### Testing Services

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRuntime, cleanupTestRuntime } from "./test-utils";
import { MyService } from "../services/myService";
import type { IAgentRuntime } from "@elizaos/core";

describe("My Service", () => {
  let runtime: IAgentRuntime;
  let service: MyService;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    service = new MyService();
    await service.start(runtime);
  });

  afterEach(async () => {
    await service.stop();
    await cleanupTestRuntime(runtime);
  });

  it("should initialize correctly", () => {
    expect(service.capabilityDescription).toBeDefined();
  });

  it("should process data", async () => {
    const result = await service.processData("test input");
    expect(result).toBeDefined();
  });
});
```

### Using vi.spyOn for Method Verification

```typescript
it("should call useModel with correct parameters", async () => {
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
