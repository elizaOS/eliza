import { describe, it, expect, jest } from "@jest/globals";
import { AgentRuntime, IAgentRuntime, Provider } from "./runtime";

// Mock default services that AgentRuntime expects
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
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
      agentId: "test",
      services: { logger: mockLogger },
    });

    const fastProvider: Provider = {
      name: "fast_provider",
      get: async () => ({ values: { data: "quick response" } }),
    };

    runtime.addProvider(fastProvider);
    const message = { text: "test" };
    const state = { values: {} };

    const resultPromise = runtime.composeState(new Set(["fast_provider"]), message, state);
    
    // Provider should complete before timeout
    await Promise.resolve(); // Let provider execute
    const result = await resultPromise;

    expect(result.values).toHaveProperty("fast_provider.data", "quick response");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("should handle timeout gracefully when provider exceeds limit", async () => {
    const runtime = new AgentRuntime({
      agentId: "test",
      services: { logger: mockLogger },
    });

    const slowProvider: Provider = {
      name: "slow_provider",
      get: async () => {
        await new Promise(resolve => setTimeout(resolve, 31_000)); // Longer than timeout
        return { values: { data: "too late" } };
      },
    };

    runtime.addProvider(slowProvider);
    const message = { text: "test" };
    const state = { values: {} };

    const resultPromise = runtime.composeState(new Set(["slow_provider"]), message, state);

    // Advance timers past the 30s timeout
    jest.advanceTimersByTime(30_001);
    
    const result = await resultPromise;

    // Should get empty values on timeout
    expect(result.values).toEqual({});
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "slow_provider",
        error: "Provider slow_provider timed out after 30000ms",
      }),
      "Provider error or timeout"
    );
  });

  it("should cleanup timers on both success and error paths", async () => {
    const runtime = new AgentRuntime({
      agentId: "test", 
      services: { logger: mockLogger },
    });

    // Test success path
    const successProvider: Provider = {
      name: "success_provider",
      get: async () => ({ values: { data: "success" } }),
    };

    runtime.addProvider(successProvider);
    let message = { text: "test" };
    let state = { values: {} };

    await runtime.composeState(new Set(["success_provider"]), message, state);
    
    // No lingering timers after success
    expect(jest.getTimerCount()).toBe(0);

    // Test error path
    const errorProvider: Provider = {
      name: "error_provider",
      get: async () => {
        throw new Error("Provider error");
      },
    };

    runtime.addProvider(errorProvider);
    message = { text: "test" };
    state = { values: {} };

    await runtime.composeState(new Set(["error_provider"]), message, state);

    // No lingering timers after error
    expect(jest.getTimerCount()).toBe(0);
  });
});
