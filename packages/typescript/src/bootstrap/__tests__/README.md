# Bootstrap Plugin Test Suite

## Overview

This directory contains a comprehensive test suite for the Eliza Bootstrap Plugin. The tests cover all major components of the plugin including actions, providers, evaluators, services, and event handling logic.

All tests use **REAL AgentRuntime instances** with mocked database adapters. There is no separate "MockRuntime" type - all tests operate against `IAgentRuntime` and use `vi.spyOn()` for method mocking when needed.

## Test Utilities

The test suite includes utilities in `test-utils.ts`:

### Runtime Creation

- `createTestRuntime(options?)`: Creates a real `AgentRuntime` with a mocked database adapter. This is the primary way to create test runtimes.

- `setupActionTest(options?)`: Quick async setup for action tests - returns runtime, message, state, callback, and IDs.

### Data Creation Utilities

- `createTestMemory(overrides?)`: Creates test Memory objects.

- `createTestState(overrides?)`: Creates test State objects.

- `createTestRoom(overrides?)`: Creates test Room objects.

- `createTestCharacter(overrides?)`: Creates test Character configurations.

- `createTestDatabaseAdapter(agentId?)`: Creates an in-memory database adapter for testing.

### Helper Utilities

- `cleanupTestRuntime(runtime)`: Properly closes and cleans up a test runtime. **Always call this in `afterEach`**.

- `waitFor(condition, timeout?, interval?)`: Waits for a condition to be true.

- `createUUID()`: Creates a UUID for testing.

## Best Practices

1. **Use Real Runtime**: Always use `createTestRuntime()` or `setupActionTest()` to create real `AgentRuntime` instances.

2. **Use `vi.spyOn` for Mocking**: If you need to mock specific methods, use `vi.spyOn(runtime, "methodName")`.

3. **Always Clean Up**: Call `cleanupTestRuntime(runtime)` in `afterEach` to properly shut down the runtime.

4. **Async Setup**: Both `createTestRuntime()` and `setupActionTest()` are async functions - use `await`.

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
import { setupActionTest, cleanupTestRuntime } from "./test-utils";
import { myAction } from "../actions";
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";

describe("My Action", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;
  let callback: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    vi.clearAllMocks();
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  it("should validate correctly", async () => {
    const setup = await setupActionTest();
    runtime = setup.runtime;
    message = setup.message;
    state = setup.state;

    const isValid = await myAction.validate(runtime, message, state);

    expect(isValid).toBe(true);
  });

  it("should handle action with custom overrides", async () => {
    const setup = await setupActionTest({
      messageOverrides: {
        content: { text: "custom message" },
      },
    });
    runtime = setup.runtime;
    message = setup.message;
    state = setup.state;
    callback = setup.callback;

    // Mock specific methods using vi.spyOn
    vi.spyOn(runtime, "getSetting").mockReturnValue("custom-value");

    const result = await myAction.handler(
      runtime,
      message,
      state,
      {},
      callback
    );

    expect(result.success).toBe(true);
    expect(callback).toHaveBeenCalled();
  });
});
```

### Testing with createTestRuntime

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestRuntime, cleanupTestRuntime, createTestMemory, createTestState } from "./test-utils";
import { myAction } from "../actions";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

describe("My Action", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory({ content: { text: "test message" } });
    state = createTestState();

    // Mock specific methods using vi.spyOn
    vi.spyOn(runtime, "getSetting").mockReturnValue("test-api-key");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should validate correctly", async () => {
    const isValid = await myAction.validate(runtime, message, state);
    expect(isValid).toBe(true);
  });

  it("should call runtime methods", async () => {
    vi.spyOn(runtime, "createMemory").mockResolvedValue("memory-id" as UUID);

    await myAction.handler(runtime, message, state);

    expect(runtime.createMemory).toHaveBeenCalled();
  });
});
```

### Testing Providers

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestRuntime, cleanupTestRuntime, createTestMemory, createTestState } from "./test-utils";
import { myProvider } from "../providers/myProvider";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

describe("My Provider", () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    message = createTestMemory();
    state = createTestState();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should return provider result", async () => {
    const result = await myProvider.get(runtime, message, state);

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });

  it("should handle custom data", async () => {
    vi.spyOn(runtime, "getMemories").mockResolvedValue([
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
  const setup = await setupActionTest();
  runtime = setup.runtime;
  message = setup.message;
  state = setup.state;

  const useModelSpy = vi.spyOn(runtime, "useModel").mockResolvedValue("yes");

  await myAction.handler(runtime, message, state, {}, vi.fn());

  expect(useModelSpy).toHaveBeenCalledWith(
    ModelType.TEXT_SMALL,
    expect.objectContaining({ prompt: expect.any(String) })
  );
});
```
