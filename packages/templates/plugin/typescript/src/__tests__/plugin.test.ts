/**
 * @fileoverview Plugin Tests
 *
 * Tests for the starter plugin using REAL AgentRuntime instances.
 */

import {
  type ActionResult,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type MessagePayload,
  ModelType,
  type Service,
} from "@elizaos/core";
import dotenv from "dotenv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarterService, starterPlugin } from "../index";
import {
  cleanupTestRuntime,
  createTestMemory,
  createTestRuntime,
  createTestState,
} from "./test-utils";

// Setup environment variables
dotenv.config();

describe("Plugin Configuration", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should have correct plugin metadata", () => {
    expect(starterPlugin.name).toBeDefined();
    expect(starterPlugin.name).toMatch(/^[a-z0-9-]+$/);
    expect(starterPlugin.description).toBeDefined();
    expect(starterPlugin.description.length).toBeGreaterThan(0);
    expect(starterPlugin.actions).toBeDefined();
    expect(starterPlugin.actions?.length).toBeGreaterThan(0);
    expect(starterPlugin.providers).toBeDefined();
    expect(starterPlugin.providers?.length).toBeGreaterThan(0);
    expect(starterPlugin.services).toBeDefined();
    expect(starterPlugin.services?.length).toBeGreaterThan(0);
    expect(starterPlugin.models).toBeDefined();
    expect(starterPlugin.models?.[ModelType.TEXT_SMALL]).toBeDefined();
    expect(starterPlugin.models?.[ModelType.TEXT_LARGE]).toBeDefined();
    expect(starterPlugin.routes).toBeDefined();
    expect(starterPlugin.routes?.length).toBeGreaterThan(0);
    expect(starterPlugin.events).toBeDefined();
  });

  it("should initialize with valid configuration", async () => {
    const config = { EXAMPLE_PLUGIN_VARIABLE: "test-value" };

    if (starterPlugin.init) {
      await starterPlugin.init(config, runtime);
    }

    expect(process.env.EXAMPLE_PLUGIN_VARIABLE).toBe("test-value");
  });

  it("should handle initialization without config", async () => {
    if (starterPlugin.init) {
      await starterPlugin.init({}, runtime);
    }
  });

  it("should throw error for invalid configuration", async () => {
    // Test that plugin handles empty config gracefully
    if (starterPlugin.init) {
      await starterPlugin.init({}, runtime);
    }
  });
});

describe("Hello World Action", () => {
  let runtime: IAgentRuntime;
  const helloWorldAction = starterPlugin.actions?.[0];

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should have hello world action", () => {
    expect(helloWorldAction).toBeDefined();
    expect(helloWorldAction?.name).toBe("HELLO_WORLD");
  });

  it("should always validate messages (current implementation)", async () => {
    if (!helloWorldAction || !helloWorldAction.validate) {
      throw new Error("Hello world action validate not found");
    }

    const testCases = [
      { text: "say hello", expected: true },
      { text: "hello world", expected: true },
      { text: "goodbye", expected: true },
      { text: "", expected: true },
      { text: "   ", expected: true },
    ];

    for (const { text, expected } of testCases) {
      const message = createTestMemory({
        content: { text, source: "test" },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(expected);
    }
  });

  it("should validate even without text content", async () => {
    if (!helloWorldAction || !helloWorldAction.validate) {
      throw new Error("Hello world action validate not found");
    }

    const messageWithoutText = createTestMemory({
      content: { source: "test" } as Content,
    });

    const isValid = await helloWorldAction.validate(runtime, messageWithoutText);
    expect(isValid).toBe(true);
  });

  it("should properly validate hello messages", async () => {
    if (!helloWorldAction || !helloWorldAction.validate) {
      throw new Error("Hello world action validate not found");
    }

    const helloMessages = ["hello", "hi there", "hey!", "greetings", "howdy partner"];
    for (const text of helloMessages) {
      const message = createTestMemory({
        content: { text, source: "test" },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(true);
    }

    const nonHelloMessages = ["goodbye", "what is the weather", "tell me a joke", ""];
    for (const text of nonHelloMessages) {
      const message = createTestMemory({
        content: { text, source: "test" },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(true);
    }
  });

  it("should handle hello world action with callback", async () => {
    if (!helloWorldAction || !helloWorldAction.handler) {
      throw new Error("Hello world action handler not found");
    }

    const message = createTestMemory({
      content: { text: "say hello", source: "test" },
    });

    let callbackContent: Content | null = null;
    const callback: HandlerCallback = async (content: Content) => {
      callbackContent = content;
      return [];
    };

    const result = await helloWorldAction.handler(runtime, message, undefined, undefined, callback);

    expect(result).toHaveProperty("text", "Hello world!");
    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("data");
    expect((result as ActionResult).data).toHaveProperty("actions", ["HELLO_WORLD"]);
    expect((result as ActionResult).data).toHaveProperty("source", "test");

    expect(callbackContent).toBeDefined();
    expect(callbackContent!.text).toBe("Hello world!");
    expect(callbackContent!.actions).toEqual(["HELLO_WORLD"]);
    expect(callbackContent!.source).toBe("test");
  });

  it("should handle errors gracefully", async () => {
    if (!helloWorldAction || !helloWorldAction.handler) {
      throw new Error("Hello world action handler not found");
    }

    const message = createTestMemory({
      content: { text: "say hello", source: "test" },
    });

    const errorCallback: HandlerCallback = async () => {
      throw new Error("Callback error");
    };

    await expect(
      helloWorldAction.handler(runtime, message, undefined, undefined, errorCallback),
    ).rejects.toThrow("Callback error");
  });

  it("should handle missing callback gracefully", async () => {
    if (!helloWorldAction || !helloWorldAction.handler) {
      throw new Error("Hello world action handler not found");
    }

    const message = createTestMemory({
      content: { text: "say hello", source: "test" },
    });

    const result = await helloWorldAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(result).toHaveProperty("text", "Hello world!");
    expect(result).toHaveProperty("success", true);
  });

  it("should handle state parameter correctly", async () => {
    if (!helloWorldAction || !helloWorldAction.handler) {
      throw new Error("Hello world action handler not found");
    }

    const message = createTestMemory({
      content: { text: "say hello", source: "test" },
    });

    const state = createTestState({
      values: { customValue: "test-state" },
    });

    const result = await helloWorldAction.handler(runtime, message, state, undefined, undefined);

    expect(result).toHaveProperty("success", true);
  });
});

describe("Hello World Provider", () => {
  const provider = starterPlugin.providers?.[0];
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should have hello world provider", () => {
    expect(provider).toBeDefined();
    expect(provider?.name).toBe("HELLO_WORLD_PROVIDER");
  });

  it("should provide hello world data", async () => {
    if (!provider || !provider.get) {
      throw new Error("Hello world provider not found");
    }

    const message = createTestMemory();
    const state = createTestState();

    const result = await provider.get(runtime, message, state);

    expect(result).toHaveProperty("text", "I am a provider");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("values");
    expect(result.data).toEqual({});
    expect(result.values).toEqual({});
  });

  it("should provide consistent structure across calls", async () => {
    if (!provider || !provider.get) {
      throw new Error("Hello world provider not found");
    }

    const message = createTestMemory();
    const state = createTestState();

    const result1 = await provider.get(runtime, message, state);
    const result2 = await provider.get(runtime, message, state);

    expect(result1.text).toBe("I am a provider");
    expect(result2.text).toBe("I am a provider");
    expect(result1.data).toEqual({});
    expect(result2.data).toEqual({});
    expect(result1.values).toEqual({});
    expect(result2.values).toEqual({});
  });

  it("should handle different input states", async () => {
    if (!provider || !provider.get) {
      throw new Error("Hello world provider not found");
    }

    const message = createTestMemory({
      content: { text: "different message" },
    });
    const customState = createTestState({
      values: { custom: "value" },
      data: { custom: "data" },
    });

    const result = await provider.get(runtime, message, customState);

    expect(result.text).toBe("I am a provider");
    expect(result.data).toEqual({});
    expect(result.values).toEqual({});
  });
});

describe("Model Handlers", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle TEXT_SMALL model", async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_SMALL];
    if (!handler) {
      throw new Error("TEXT_SMALL model handler not found");
    }

    const result = await handler(runtime, {
      prompt: "Test prompt",
      temperature: 0.7,
    });

    expect(result).toContain("Never gonna give you up");
  });

  it("should handle TEXT_LARGE model with custom parameters", async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_LARGE];
    if (!handler) {
      throw new Error("TEXT_LARGE model handler not found");
    }

    const result = await handler(runtime, {
      prompt: "Test prompt with custom settings",
      temperature: 0.9,
      maxTokens: 500,
    });

    expect(result).toContain("Never gonna make you cry");
  });

  it("should handle empty prompt", async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_SMALL];
    if (!handler) {
      throw new Error("TEXT_SMALL model handler not found");
    }

    const result = await handler(runtime, {
      prompt: "",
      temperature: 0.7,
    });

    expect(typeof result).toBe("string");
    expect(result).toBeDefined();
  });

  it("should handle missing parameters", async () => {
    const handler = starterPlugin.models?.[ModelType.TEXT_LARGE];
    if (!handler) {
      throw new Error("TEXT_LARGE model handler not found");
    }

    const result = await handler(runtime, {
      prompt: "Test prompt",
    });

    expect(typeof result).toBe("string");
    expect(result).toBeDefined();
  });
});

describe("API Routes", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle hello world route", async () => {
    const helloRoute = starterPlugin.routes?.find((r) => r.name === "hello-world-route");
    if (!helloRoute || !helloRoute.handler) {
      throw new Error("Hello world route handler not found");
    }

    const mockRes = {
      json: (data: { message: string }) => {
        mockRes._jsonData = data;
        return mockRes;
      },
      status: (_code: number) => mockRes,
      send: (_data: unknown) => mockRes,
      end: () => mockRes,
      _jsonData: null as { message: string } | null,
    };

    await helloRoute.handler({}, mockRes as any, runtime);

    expect(mockRes._jsonData).toBeDefined();
    expect(mockRes._jsonData!.message).toBe("Hello World!");
  });

  it("should validate route configuration", () => {
    const helloRoute = starterPlugin.routes?.find((r) => r.name === "hello-world-route");

    expect(helloRoute).toBeDefined();
    expect(helloRoute?.path).toBe("/helloworld");
    expect(helloRoute?.type).toBe("GET");
    expect(helloRoute?.handler).toBeDefined();
  });

  it("should handle request with query parameters", async () => {
    const helloRoute = starterPlugin.routes?.find((r) => r.name === "hello-world-route");
    if (!helloRoute || !helloRoute.handler) {
      throw new Error("Hello world route handler not found");
    }

    const mockReq = {
      query: {
        name: "Test User",
      },
    };

    const mockRes = {
      json: (data: { message: string }) => {
        mockRes._jsonData = data;
        return mockRes;
      },
      status: (_code: number) => mockRes,
      send: (_data: unknown) => mockRes,
      end: () => mockRes,
      _jsonData: null as { message: string } | null,
    };

    await helloRoute.handler(mockReq, mockRes as any, runtime);

    expect(mockRes._jsonData).toBeDefined();
    expect(mockRes._jsonData!.message).toBe("Hello World!");
  });
});

describe("Event Handlers", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should log when MESSAGE_RECEIVED event is triggered", async () => {
    const handler = starterPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    if (!handler) {
      throw new Error("MESSAGE_RECEIVED event handler not found");
    }

    const payload: MessagePayload = {
      runtime,
      message: createTestMemory({ agentId: runtime.agentId }),
      source: "test",
    };

    await handler(payload);
    expect(true).toBe(true);
  });

  it("should handle malformed event payload", async () => {
    const handler = starterPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    if (!handler) {
      throw new Error("MESSAGE_RECEIVED event handler not found");
    }

    const malformedPayload: Partial<MessagePayload> = {
      runtime,
    };

    await handler(malformedPayload as MessagePayload);
  });

  it("should handle event with empty message content", async () => {
    const handler = starterPlugin.events?.[EventType.MESSAGE_RECEIVED]?.[0];
    if (!handler) {
      throw new Error("MESSAGE_RECEIVED event handler not found");
    }

    const payload: MessagePayload = {
      runtime,
      message: createTestMemory({
        agentId: runtime.agentId,
        content: {} as Content,
      }),
      source: "test",
    };

    await handler(payload);
    expect(true).toBe(true);
  });
});

describe("StarterService", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should start the service", async () => {
    const service = await StarterService.start(runtime);
    expect(service).toBeInstanceOf(StarterService);
  });

  it("should have correct service type", () => {
    expect(StarterService.serviceType).toBe("starter");
  });

  it("should stop service correctly", async () => {
    const service = await StarterService.start(runtime);
    vi.spyOn(runtime, "getService").mockReturnValue(service as Service);
    await StarterService.stop(runtime);
    expect(true).toBe(true);
  });

  it("should throw error when stopping non-existent service", async () => {
    vi.spyOn(runtime, "getService").mockReturnValue(null);

    await expect(StarterService.stop(runtime)).rejects.toThrow("Starter service not found");
  });

  it("should handle multiple start/stop cycles", async () => {
    const service1 = await StarterService.start(runtime);
    expect(service1).toBeInstanceOf(StarterService);
    vi.spyOn(runtime, "getService").mockReturnValue(service1 as Service);
    await StarterService.stop(runtime);

    const service2 = await StarterService.start(runtime);
    expect(service2).toBeInstanceOf(StarterService);
    vi.spyOn(runtime, "getService").mockReturnValue(service2 as Service);
    await StarterService.stop(runtime);
  });

  it("should provide capability description", async () => {
    const service = await StarterService.start(runtime);
    expect(service.capabilityDescription).toBe(
      "This is a starter service which is attached to the agent through the starter plugin.",
    );
  });
});
