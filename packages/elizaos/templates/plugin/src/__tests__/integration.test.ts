import type { Content, HandlerCallback, IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { starterPlugin } from "../index";
import { cleanupTestRuntime, createTestRuntime, setupLoggerSpies } from "./test-utils";

/**
 * Integration tests demonstrate how multiple components of the plugin work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 *
 * For example, this file shows how the HelloWorld action and HelloWorld provider
 * interact with the plugin's core functionality.
 */

// Set up spies on logger
beforeAll(() => {
  setupLoggerSpies();
});

afterAll(() => {
  // No global restore needed in vitest
});

describe("Integration: HelloWorld Action", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    // Create real runtime
    runtime = await createTestRuntime({ skipInitialize: true });
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle HelloWorld action", async () => {
    // Find the HelloWorld action
    const helloWorldAction = starterPlugin.actions?.find((action) => action.name === "HELLO_WORLD");
    expect(helloWorldAction).toBeDefined();

    // Create a mock message and state
    const mockMessage: Memory = {
      id: "12345678-1234-1234-1234-123456789012" as UUID,
      roomId: "12345678-1234-1234-1234-123456789012" as UUID,
      entityId: "12345678-1234-1234-1234-123456789012" as UUID,
      agentId: "12345678-1234-1234-1234-123456789012" as UUID,
      content: {
        text: "Hello world",
        source: "test",
      },
      createdAt: Date.now(),
    };

    const mockState: State = {
      values: {},
      data: {},
      text: "",
    };

    // Create a mock callback to capture the response
    const callbackCalls: [Content][] = [];
    const callbackFn: HandlerCallback = async (content: Content) => {
      callbackCalls.push([content]);
      return [];
    };

    // Execute the action
    if (helloWorldAction) {
      await helloWorldAction.handler(runtime, mockMessage, mockState, {}, callbackFn, []);
    }

    // Verify the callback was called with expected response
    expect(callbackCalls.length).toBeGreaterThan(0);
    if (callbackCalls.length > 0) {
      expect(callbackCalls[0][0].text).toBe("Hello world!");
      expect(callbackCalls[0][0].actions).toEqual(["HELLO_WORLD"]);
      expect(callbackCalls[0][0].source).toBe("test");
    }
  });
});

describe("Integration: Plugin initialization", () => {
  let runtime: IAgentRuntime;

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  it("should initialize the plugin and expose the example starter service", async () => {
    runtime = await createTestRuntime({ skipInitialize: true });

    if (starterPlugin.init) {
      await starterPlugin.init({ EXAMPLE_PLUGIN_VARIABLE: "test-value" }, runtime);
    }

    expect(starterPlugin.services ?? []).toHaveLength(1);
  });
});
