import { describe, it, expect, jest } from "@jest/globals";
import { AgentRuntime } from "./runtime";
import type { Provider, Memory } from "./types";

// Mock default services that AgentRuntime expects
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

// Mock adapter for AgentRuntime
const mockAdapter = {
  getConnection: jest.fn(),
  createMemory: jest.fn(),
  getMemoryById: jest.fn(),
};

describe("AgentRuntime provider timeout handling", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("should successfully complete when provider responds within timeout", async () => {
    const runtime = new AgentRuntime({
      agentId: "test" as any,
      adapter: mockAdapter as any,
    });

    const fastProvider: Provider = {
      name: "fast_provider",
      get: async () => ({ values: { data: "quick response" }, data: {}, text: "" }),
    };

    runtime.registerProvider(fastProvider);
    const message = { id: "test-msg", roomId: "test-room", entityId: "test-entity", content: { text: "test" } } as Memory;

    const resultPromise = runtime.composeState(message, ["fast_provider"]);
    
    // Provider should complete before timeout
    await Promise.resolve(); // Let provider execute
    const result = await resultPromise;

    expect(result.values).toHaveProperty("fast_provider");
  });

  it("should handle timeout gracefully when provider exceeds limit", async () => {
    const runtime = new AgentRuntime({
      agentId: "test" as any,
      adapter: mockAdapter as any,
    });

    const slowProvider: Provider = {
      name: "slow_provider",
      get: async () => {
        await new Promise(resolve => setTimeout(resolve, 31_000)); // Longer than timeout
        return { values: { data: "too late" }, data: {}, text: "" };
      },
    };

    runtime.registerProvider(slowProvider);
    const message = { id: "test-msg", roomId: "test-room", entityId: "test-entity", content: { text: "test" } } as Memory;

    const resultPromise = runtime.composeState(message, ["slow_provider"]);

    // Advance timers past the 30s timeout
    jest.advanceTimersByTime(30_001);
    
    const result = await resultPromise;

    // Should get result (possibly empty on timeout)
    expect(result).toBeDefined();
  });

  it("should cleanup timers on both success and error paths", async () => {
    const runtime = new AgentRuntime({
      agentId: "test" as any,
      adapter: mockAdapter as any,
    });

    // Test success path
    const successProvider: Provider = {
      name: "success_provider",
      get: async () => ({ values: { data: "success" }, data: {}, text: "" }),
    };

    runtime.registerProvider(successProvider);
    const message = { id: "test-msg", roomId: "test-room", entityId: "test-entity", content: { text: "test" } } as Memory;

    await runtime.composeState(message, ["success_provider"]);
    
    // No lingering timers after success
    expect(jest.getTimerCount()).toBe(0);

    // Test error path
    const errorProvider: Provider = {
      name: "error_provider",
      get: async () => {
        throw new Error("Provider error");
      },
    };

    runtime.registerProvider(errorProvider);
    const message2 = { id: "test-msg2", roomId: "test-room", entityId: "test-entity", content: { text: "test" } } as Memory;

    await runtime.composeState(message2, ["error_provider"]);

    // No lingering timers after error
    expect(jest.getTimerCount()).toBe(0);
  });
});
