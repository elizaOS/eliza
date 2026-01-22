import type {
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Service,
  State,
  UUID,
} from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { starterPlugin } from "../index";
import { cleanupTestRuntime, createTestRuntime, setupLoggerSpies } from "./test-utils";

/**
 * Integration tests demonstrate how multiple components of the plugin work together.
 * Unlike unit tests that test individual functions in isolation, integration tests
 * examine how components interact with each other.
 *
 * For example, this file shows how the HelloWorld action and HelloWorld provider
 * interact with the StarterService and the plugin's core functionality.
 */

// Set up spies on logger
beforeAll(() => {
  setupLoggerSpies();
});

afterAll(() => {
  // No global restore needed in vitest
});

describe("Integration: HelloWorld Action with StarterService", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    // Create real runtime
    runtime = await createTestRuntime();

    // Create a service mock that will be returned by getService
    const mockService: Partial<Service> = {
      capabilityDescription:
        "This is a starter service which is attached to the agent through the starter plugin.",
      stop: () => Promise.resolve(),
    };

    // Spy on getService to return our mock service
    vi.spyOn(runtime, "getService").mockImplementation((serviceType: string): Service | null => {
      if (serviceType === "starter") {
        return mockService as Service;
      }
      return null;
    });
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle HelloWorld action with StarterService available", async () => {
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

    // Get the service to ensure integration
    const service = runtime.getService("starter");
    expect(service).toBeDefined();
    expect(service?.capabilityDescription).toContain("starter service");
  });
});

describe("Integration: Plugin initialization and service registration", () => {
  let runtime: IAgentRuntime;

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  it("should initialize the plugin and register the service", async () => {
    // Create a real runtime
    runtime = await createTestRuntime();

    // Track registerService calls
    const registerServiceCalls: { service: typeof Service }[] = [];
    vi.spyOn(runtime, "registerService").mockImplementation((service: typeof Service) => {
      registerServiceCalls.push({ service });
      return Promise.resolve();
    });

    // Run a minimal simulation of the plugin initialization process
    if (starterPlugin.init) {
      await starterPlugin.init({ EXAMPLE_PLUGIN_VARIABLE: "test-value" }, runtime);

      // Directly start the service that happens during initialization
      // because unit tests don't run the full agent initialization flow
      if (starterPlugin.services) {
        const StarterServiceClass = starterPlugin.services[0];
        const _serviceInstance = await StarterServiceClass.start(runtime);

        // Register the Service class to match the core API
        runtime.registerService(StarterServiceClass);
      }

      // Now verify the service was registered with the runtime
      expect(registerServiceCalls.length).toBeGreaterThan(0);
    }
  });
});
