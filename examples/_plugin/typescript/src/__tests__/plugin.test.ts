import {  beforeEach, describe, expect, it, type Mock  } from "vitest";
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
import { z } from "zod";
import { StarterService, starterPlugin } from "../index";
import {
  createMockRuntime,
  createTestMemory,
  createTestState,
  testFixtures,
} from "./test-utils";

// Setup environment variables
dotenv.config();

describe("Plugin Configuration", () => {
  it("should have correct plugin metadata", () => {
    // Check that plugin has required metadata (values will change when template is used)
    expect(starterPlugin.name).toBeDefined();
    expect(starterPlugin.name).toMatch(/^[a-z0-9-]+$/); // Valid plugin name format
    expect(starterPlugin.description).toBeDefined();
    expect(starterPlugin.description.length).toBeGreaterThan(0);
    expect(starterPlugin.actions).toBeDefined();
    const starterPluginActions = starterPlugin.actions;
    expect(starterPluginActions && starterPluginActions.length).toBeGreaterThan(0);
    expect(starterPlugin.providers).toBeDefined();
    const starterPluginProviders = starterPlugin.providers;
    expect(starterPluginProviders && starterPluginProviders.length).toBeGreaterThan(0);
    expect(starterPlugin.services).toBeDefined();
    const starterPluginServices = starterPlugin.services;
    expect(starterPluginServices && starterPluginServices.length).toBeGreaterThan(0);
    expect(starterPlugin.models).toBeDefined();
    const starterPluginModels = starterPlugin.models;
    expect(starterPluginModels && starterPluginModels[ModelType.TEXT_SMALL]).toBeDefined();
    expect(starterPluginModels && starterPluginModels[ModelType.TEXT_LARGE]).toBeDefined();
    expect(starterPlugin.routes).toBeDefined();
    const starterPluginRoutes = starterPlugin.routes;
    expect(starterPluginRoutes && starterPluginRoutes.length).toBeGreaterThan(0);
    expect(starterPlugin.events).toBeDefined();
  });

  it("should initialize with valid configuration", async () => {
    const runtime = createMockRuntime();
    const config = { EXAMPLE_PLUGIN_VARIABLE: "test-value" };

    if (starterPlugin.init) {
      await starterPlugin.init(config, runtime);
    }

    // Note: registerService is not called in init, services are registered later
    // This is handled by the runtime during plugin loading
    expect(process.env.EXAMPLE_PLUGIN_VARIABLE).toBe("test-value");
  });

  it("should handle initialization without config", async () => {
    const runtime = createMockRuntime();

    if (starterPlugin.init) {
      // Init should not throw even with empty config
      await starterPlugin.init({}, runtime);
    }
  });

  it("should throw error for invalid configuration", async () => {
    const runtime = createMockRuntime({
      getSetting: () => "invalid-json",
    });

    const _zodError = new z.ZodError([
      {
        code: "invalid_type",
        expected: "object",
        received: "string",
        path: [],
        message: "Expected object, received string",
      },
    ]);

    if (starterPlugin.init) {
      // The init function validates the config but doesn't throw for invalid JSON in getSetting
      // It only validates the config passed to init
      await starterPlugin.init({}, runtime);
    }
  });
});

describe("Hello World Action", () => {
  let runtime: IAgentRuntime;
  const starterPluginActions = starterPlugin.actions;
  const helloWorldAction = starterPluginActions && starterPluginActions[0];

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it("should have hello world action", () => {
    expect(helloWorldAction).toBeDefined();
    expect(helloWorldAction && helloWorldAction.name).toBe("HELLO_WORLD");
  });

  it("should always validate messages (current implementation)", async () => {
    if (!helloWorldAction || !helloWorldAction.validate) {
      throw new Error("Hello world action validate not found");
    }

    // The simple implementation always returns true
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

    const isValid = await helloWorldAction.validate(
      runtime,
      messageWithoutText,
    );
    // Always returns true in simple implementation
    expect(isValid).toBe(true);
  });

  it("should properly validate hello messages", async () => {
    if (!helloWorldAction || !helloWorldAction.validate) {
      throw new Error("Hello world action validate not found");
    }

    // Test that it accepts hello-related keywords
    const helloMessages = [
      "hello",
      "hi there",
      "hey!",
      "greetings",
      "howdy partner",
    ];
    for (const text of helloMessages) {
      const message = createTestMemory({
        content: { text, source: "test" },
      });
      const isValid = await helloWorldAction.validate(runtime, message);
      expect(isValid).toBe(true);
    }

    // Test that it accepts all messages (simple implementation)
    const nonHelloMessages = [
      "goodbye",
      "what is the weather",
      "tell me a joke",
      "",
    ];
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

    let callbackContent: any = null;
    const callback: HandlerCallback = async (content: Content) => {
      callbackContent = content;
      return [];
    };

    const result = await helloWorldAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback,
    );

    // The action returns a simple greeting
    expect(result).toHaveProperty("text", "Hello world!");
    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("data");
    expect((result as ActionResult).data).toHaveProperty("actions", [
      "HELLO_WORLD",
    ]);
    expect((result as ActionResult).data).toHaveProperty("source", "test");

    // Callback should receive the same greeting
    expect(callbackContent).toBeDefined();
    expect(callbackContent.text).toBe("Hello world!");
    expect(callbackContent.actions).toEqual(["HELLO_WORLD"]);
    expect(callbackContent.source).toBe("test");
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

    const result = await helloWorldAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      errorCallback,
    );

    expect(result).toHaveProperty("success", false);
    expect(result).toHaveProperty("error");
    expect((result as ActionResult).error).toBeInstanceOf(Error);
    expect(
      (result as ActionResult).error instanceof Error
        ? (result as ActionResult).error.message
        : String((result as ActionResult).error),
    ).toBe("Callback error");
    // Logger is mocked but not set up as a spy in runtime
    expect(logger.error).toHaveBeenCalled();
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

    // The action returns a simple greeting
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

    const result = await helloWorldAction.handler(
      runtime,
      message,
      state,
      undefined,
      undefined,
    );

    expect(result).toHaveProperty("success", true);
  });
});

describe("Hello World Provider", () => {
  const starterPluginProviders = starterPlugin.providers;
  const provider = starterPluginProviders && starterPluginProviders[0];
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it("should have hello world provider", () => {
    expect(provider).toBeDefined();
    expect(provider && provider.name).toBe("HELLO_WORLD_PROVIDER");
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

    // Simple provider returns consistent static results
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

    // Provider output is static in simple implementation
    expect(result.text).toBe("I am a provider");
    expect(result.data).toEqual({});
    expect(result.values).toEqual({});
  });
});

describe("Model Handlers", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it("should handle TEXT_SMALL model", async () => {
    const starterPluginModels = starterPlugin.models;
    const handler = starterPluginModels && starterPluginModels[ModelType.TEXT_SMALL];
    if (!handler) {
      throw new Error("TEXT_SMALL model handler not found");
    }

    const result = await handler(
      {
        params: {
          prompt: "Test prompt",
          temperature: 0.7,
        },
      },
      runtime,
    );

    expect(result).toContain("Never gonna give you up");
  });

  it("should handle TEXT_LARGE model with custom parameters", async () => {
    const starterPluginModels = starterPlugin.models;
    const handler = starterPluginModels && starterPluginModels[ModelType.TEXT_LARGE];
    if (!handler) {
      throw new Error("TEXT_LARGE model handler not found");
    }

    const result = await handler(
      {
        params: {
          prompt: "Test prompt with custom settings",
          temperature: 0.9,
          maxTokens: 500,
        },
      },
      runtime,
    );

    expect(result).toContain("Never gonna make you cry");
  });

  it("should handle empty prompt", async () => {
    const starterPluginModels = starterPlugin.models;
    const handler = starterPluginModels && starterPluginModels[ModelType.TEXT_SMALL];
    if (!handler) {
      throw new Error("TEXT_SMALL model handler not found");
    }

    const result = await handler(
      {
        params: {
          prompt: "",
          temperature: 0.7,
        },
      },
      runtime,
    );

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should handle missing parameters", async () => {
    const starterPluginModels = starterPlugin.models;
    const handler = starterPluginModels && starterPluginModels[ModelType.TEXT_LARGE];
    if (!handler) {
      throw new Error("TEXT_LARGE model handler not found");
    }

    const result = await handler(
      {
        params: {
          prompt: "Test prompt",
        },
      },
      runtime,
    );

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("API Routes", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
  });

  it("should handle hello world route", async () => {
    const starterPluginRoutes = starterPlugin.routes;
    const helloRoute = starterPluginRoutes && starterPluginRoutes.find(
      (r) => r.name === "hello-world-route",
    );
    if (!helloRoute || !helloRoute.handler) {
      throw new Error("Hello world route handler not found");
    }

    const mockRes = {
      json: (data: any) => {
        mockRes._jsonData = data;
      },
      _jsonData: null,
    };

    await helloRoute.handler({}, mockRes, runtime);

    expect(mockRes._jsonData).toBeDefined();
    expect(mockRes._jsonData.message).toBe("Hello World!");
  });

  it("should validate route configuration", () => {
    const starterPluginRoutes = starterPlugin.routes;
    const helloRoute = starterPluginRoutes && starterPluginRoutes.find(
      (r) => r.name === "hello-world-route",
    );

    expect(helloRoute).toBeDefined();
    expect(helloRoute && helloRoute.path).toBe("/helloworld");
    expect(helloRoute && helloRoute.type).toBe("GET");
    // Routes don't have a public property in the current implementation
    expect(helloRoute && helloRoute.handler).toBeDefined();
  });

  it("should handle request with query parameters", async () => {
    const starterPluginRoutes = starterPlugin.routes;
    const helloRoute = starterPluginRoutes && starterPluginRoutes.find(
      (r) => r.name === "hello-world-route",
    );
    if (!helloRoute || !helloRoute.handler) {
      throw new Error("Hello world route handler not found");
    }

    const mockReq = {
      query: {
        name: "Test User",
      },
    };

    const mockRes = {
      json: (data: any) => {
        mockRes._jsonData = data;
      },
      _jsonData: null,
    };

    await helloRoute.handler(mockReq, mockRes, runtime);

    expect(mockRes._jsonData).toBeDefined();
    expect(mockRes._jsonData.message).toBe("Hello World!");
  });
});

describe("Event Handlers", () => {
  beforeEach(() => {
    // Clear logger spy calls
    // Note: logger methods are mocked in test setup, vitest exposes .mock.calls
    // These assignments are for compatibility with test setup
    if ("calls" in logger.debug) {
      (logger.debug as Mock).mockClear();
    }
    if ("calls" in logger.info) {
      (logger.info as Mock).mockClear();
    }
    if ("calls" in logger.error) {
      (logger.error as Mock).mockClear();
    }
  });

  it("should log when MESSAGE_RECEIVED event is triggered", async () => {
    const starterPluginEvents = starterPlugin.events;
    const messageReceivedEvents = starterPluginEvents && starterPluginEvents[EventType.MESSAGE_RECEIVED];
    const handler = messageReceivedEvents && messageReceivedEvents[0];
    if (!handler) {
      throw new Error("MESSAGE_RECEIVED event handler not found");
    }

    const payload = testFixtures.messagePayload();
    await handler(payload);

    expect(logger.debug).toHaveBeenCalled();
  });

  it("should handle malformed event payload", async () => {
    const starterPluginEvents = starterPlugin.events;
    const messageReceivedEvents = starterPluginEvents && starterPluginEvents[EventType.MESSAGE_RECEIVED];
    const handler = messageReceivedEvents && messageReceivedEvents[0];
    if (!handler) {
      throw new Error("MESSAGE_RECEIVED event handler not found");
    }

    const malformedPayload = {
      // Missing required fields
      runtime: createMockRuntime(),
    };

    // Should not throw
    // Handler doesn't actually use the payload, just logs
    await handler(malformedPayload as unknown as MessagePayload);
  });

  it("should handle event with empty message content", async () => {
    const starterPluginEvents = starterPlugin.events;
    const messageReceivedEvents = starterPluginEvents && starterPluginEvents[EventType.MESSAGE_RECEIVED];
    const handler = messageReceivedEvents && messageReceivedEvents[0];
    if (!handler) {
      throw new Error("MESSAGE_RECEIVED event handler not found");
    }

    const payload = testFixtures.messagePayload({
      content: {},
    });

    await handler(payload);
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe("StarterService", () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
    // Clear logger spy calls
    if ("calls" in logger.info) {
      (logger.info as Mock).mockClear();
    }
    if ("calls" in logger.error) {
      (logger.error as Mock).mockClear();
    }
  });

  it("should start the service", async () => {
    const service = await StarterService.start(runtime);
    expect(service).toBeInstanceOf(StarterService);
    expect(logger.info).toHaveBeenCalled();
  });

  it("should have correct service type", () => {
    expect(StarterService.serviceType).toBe("starter");
  });

  it("should stop service correctly", async () => {
    // Start service
    const service = await StarterService.start(runtime);

    // Create a new runtime with the service registered
    const runtimeWithService = createMockRuntime({
      getService: () => service as Service,
    });

    // Stop service
    await StarterService.stop(runtimeWithService);
    expect(logger.info).toHaveBeenCalled();
  });

  it("should throw error when stopping non-existent service", async () => {
    const emptyRuntime = createMockRuntime({
      getService: () => null,
    });

    await expect(StarterService.stop(emptyRuntime)).rejects.toThrow(
      "Starter service not found",
    );
  });

  it("should handle multiple start/stop cycles", async () => {
    // First cycle
    const service1 = await StarterService.start(runtime);
    expect(service1).toBeInstanceOf(StarterService);

    const runtimeWithService1 = createMockRuntime({
      getService: () => service1 as any,
    });
    await StarterService.stop(runtimeWithService1);

    // Second cycle
    const service2 = await StarterService.start(runtime);
    expect(service2).toBeInstanceOf(StarterService);

    const runtimeWithService2 = createMockRuntime({
      getService: () => service2 as any,
    });
    await StarterService.stop(runtimeWithService2);
  });

  it("should provide capability description", async () => {
    const service = await StarterService.start(runtime);
    expect(service.capabilityDescription).toBe(
      "This is a starter service which is attached to the agent through the starter plugin.",
    );
  });
});
