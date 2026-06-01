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

  it("validates hello intent from either message text or recent messages", async () => {
    const helloWorldAction = starterPlugin.actions?.find((action) => action.name === "HELLO_WORLD");
    expect(helloWorldAction).toBeDefined();
    if (!helloWorldAction) throw new Error("Expected HELLO_WORLD action");

    const baseMessage: Memory = {
      id: "12345678-1234-1234-1234-123456789013" as UUID,
      roomId: "12345678-1234-1234-1234-123456789012" as UUID,
      entityId: "12345678-1234-1234-1234-123456789012" as UUID,
      agentId: "12345678-1234-1234-1234-123456789012" as UUID,
      content: {
        text: "tell me something",
        source: "test",
      },
      createdAt: Date.now(),
    };

    await expect(
      helloWorldAction.validate(runtime, baseMessage, {
        values: {},
        data: {},
        text: "",
      }),
    ).resolves.toBe(false);
    await expect(
      helloWorldAction.validate(runtime, baseMessage, {
        values: { recentMessages: "the user said bonjour earlier" },
        data: {},
        text: "",
      }),
    ).resolves.toBe(true);
  });
});

describe("Integration: Provider, models, and routes", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime({ skipInitialize: true });
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("provider returns stable starter context", async () => {
    const provider = starterPlugin.providers?.find(
      (entry) => entry.name === "HELLO_WORLD_PROVIDER",
    );
    expect(provider).toBeDefined();
    if (!provider) throw new Error("Expected HELLO_WORLD_PROVIDER");

    const result = await provider.get(
      runtime,
      {
        id: "12345678-1234-1234-1234-123456789014" as UUID,
        roomId: "12345678-1234-1234-1234-123456789012" as UUID,
        entityId: "12345678-1234-1234-1234-123456789012" as UUID,
        agentId: "12345678-1234-1234-1234-123456789012" as UUID,
        content: { text: "context", source: "test" },
        createdAt: Date.now(),
      },
      { values: {}, data: {}, text: "" },
    );

    expect(result).toEqual({
      text: "I am a provider",
      values: {},
      data: {},
    });
  });

  it("model handlers return their fixture responses", async () => {
    const smallModel = starterPlugin.models?.TEXT_SMALL;
    const largeModel = starterPlugin.models?.TEXT_LARGE;
    expect(smallModel).toBeDefined();
    expect(largeModel).toBeDefined();
    if (!smallModel || !largeModel) throw new Error("Expected starter models");

    await expect(smallModel(runtime, { prompt: "hello", stopSequences: [] })).resolves.toContain(
      "Never gonna give you up",
    );
    await expect(
      largeModel(runtime, { prompt: "hello", stopSequences: [], maxTokens: 32 }),
    ).resolves.toContain("Never gonna make you cry");
  });

  it("route handlers return expected JSON payloads", async () => {
    const helloRoute = starterPlugin.routes?.find((route) => route.path === "/helloworld");
    const timeRoute = starterPlugin.routes?.find((route) => route.path === "/api/time");
    expect(helloRoute).toBeDefined();
    expect(timeRoute).toBeDefined();
    if (!helloRoute || !timeRoute) throw new Error("Expected starter routes");

    const helloResponses: unknown[] = [];
    await helloRoute.handler(
      {} as never,
      {
        json: (body: unknown) => helloResponses.push(body),
      } as never,
    );
    expect(helloResponses).toEqual([{ message: "Hello World!" }]);

    const timeResponses: Array<Record<string, unknown>> = [];
    await timeRoute.handler(
      {} as never,
      {
        json: (body: Record<string, unknown>) => timeResponses.push(body),
      } as never,
    );
    expect(timeResponses[0]).toMatchObject({
      timezone: expect.any(String),
    });
    expect(typeof timeResponses[0]?.timestamp).toBe("string");
    expect(typeof timeResponses[0]?.unix).toBe("number");
    expect(typeof timeResponses[0]?.formatted).toBe("string");
  });
});

describe("Integration: Plugin initialization", () => {
  let runtime: IAgentRuntime;
  const originalExamplePluginVariable = process.env.EXAMPLE_PLUGIN_VARIABLE;

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
    if (originalExamplePluginVariable === undefined) {
      delete process.env.EXAMPLE_PLUGIN_VARIABLE;
    } else {
      process.env.EXAMPLE_PLUGIN_VARIABLE = originalExamplePluginVariable;
    }
  });

  it("should initialize the plugin and register the starter service", async () => {
    // Create a real runtime
    runtime = await createTestRuntime({ skipInitialize: true });

    // Run a minimal simulation of the plugin initialization process
    if (starterPlugin.init) {
      await starterPlugin.init({ EXAMPLE_PLUGIN_VARIABLE: "test-value" }, runtime);
    }

    expect(starterPlugin.services ?? []).toHaveLength(1);
    expect(starterPlugin.services?.[0]?.serviceType).toBe("starter");
    expect(process.env.EXAMPLE_PLUGIN_VARIABLE).toBe("test-value");
  });

  it("rejects invalid plugin configuration", async () => {
    runtime = await createTestRuntime({ skipInitialize: true });

    await expect(starterPlugin.init?.({ EXAMPLE_PLUGIN_VARIABLE: "" }, runtime)).rejects.toThrow(
      /Invalid plugin configuration: Example plugin variable is not provided/,
    );
  });

  it("disposes the starter service when the runtime exposes one", async () => {
    const stopCalls: string[] = [];
    await starterPlugin.dispose?.({
      getService: (serviceType: string) =>
        serviceType === "starter"
          ? {
              stop: async () => {
                stopCalls.push(serviceType);
              },
            }
          : null,
    } as unknown as IAgentRuntime);

    expect(stopCalls).toEqual(["starter"]);
  });

  it("does not throw during dispose when the starter service is absent", async () => {
    await expect(
      starterPlugin.dispose?.({
        getService: () => null,
      } as unknown as IAgentRuntime),
    ).resolves.toBeUndefined();
  });
});
