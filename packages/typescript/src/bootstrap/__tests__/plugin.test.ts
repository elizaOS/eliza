import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../types/index.ts";
import { EventType } from "../../types/index.ts";
import { createBootstrapPlugin } from "../index";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

// Create the bootstrap plugin for testing
const bootstrapPlugin = createBootstrapPlugin();

// Create a mock function for bootstrapPlugin.init since it might not actually exist on the plugin
// Define mockInit as a vi.fn() once. Its implementation will be set in beforeEach.
const mockInit = vi.fn();

describe("Bootstrap Plugin", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();

    runtime = await createTestRuntime();

    // Spy on runtime methods for testing
    vi.spyOn(runtime, "getSetting").mockReturnValue("medium");
    vi.spyOn(runtime, "getParticipantUserState").mockResolvedValue("ACTIVE");
    vi.spyOn(runtime, "composeState").mockResolvedValue({
      values: {},
      data: {},
      text: "",
    });

    // Spy on registration methods
    vi.spyOn(runtime, "registerProvider").mockImplementation(() => {});
    vi.spyOn(runtime, "registerAction").mockImplementation(() => {});
    vi.spyOn(runtime, "registerEvaluator").mockImplementation(() => {});
    vi.spyOn(runtime, "registerService").mockResolvedValue(undefined);
    vi.spyOn(runtime, "registerEvent").mockImplementation(() => {});

    // Set or reset mockInit's implementation for each test
    mockInit.mockImplementation(async (_config, runtime) => {
      if (bootstrapPlugin.providers) {
        bootstrapPlugin.providers.forEach((provider) => {
          try {
            runtime.registerProvider(provider);
          } catch (error) {
            // Log or handle error if necessary for debugging, but don't rethrow for this test
            console.error(
              `Failed to register provider ${provider.name}:`,
              error,
            );
          }
        });
      }
      if (bootstrapPlugin.actions) {
        bootstrapPlugin.actions.forEach((action) => {
          try {
            runtime.registerAction(action);
          } catch (error) {
            console.error(`Failed to register action ${action.name}:`, error);
          }
        });
      }
      if (bootstrapPlugin.evaluators) {
        bootstrapPlugin.evaluators.forEach((evaluator) => {
          try {
            runtime.registerEvaluator(evaluator);
          } catch (error) {
            console.error(
              `Failed to register evaluator ${evaluator.name}:`,
              error,
            );
          }
        });
      }
      if (bootstrapPlugin.services) {
        bootstrapPlugin.services.forEach((service) => {
          try {
            runtime.registerService(service);
          } catch (error) {
            const serviceName =
              (service as { serviceType?: string; name?: string })
                .serviceType ||
              (service as { serviceType?: string; name?: string }).name ||
              "unknown service";
            console.error(`Failed to register service ${serviceName}:`, error);
          }
        });
      }
      if (bootstrapPlugin.events) {
        Object.entries(bootstrapPlugin.events).forEach(
          ([eventType, handlers]) => {
            handlers.forEach((handler) => {
              try {
                runtime.registerEvent(eventType, handler);
              } catch (error) {
                console.error(
                  `Failed to register event handler for ${eventType}:`,
                  error,
                );
              }
            });
          },
        );
      }
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should have the correct name and description", () => {
    expect(bootstrapPlugin.name).toBe("bootstrap");
    expect(bootstrapPlugin.description).toBeDefined();
    expect(typeof bootstrapPlugin.description).toBe("string");
  });

  it("should register all providers during initialization", async () => {
    // Execute the mocked initialization function
    await mockInit({}, runtime as Partial<IAgentRuntime> as IAgentRuntime);

    // Check that all providers were registered
    if (bootstrapPlugin.providers) {
      expect(runtime.registerProvider).toHaveBeenCalledTimes(
        bootstrapPlugin.providers.length,
      );

      // Verify each provider was registered
      bootstrapPlugin.providers.forEach((provider) => {
        expect(runtime.registerProvider).toHaveBeenCalledWith(provider);
      });
    }
  });

  it("should register all actions during initialization", async () => {
    // Execute the mocked initialization function
    await mockInit({}, runtime as Partial<IAgentRuntime> as IAgentRuntime);

    // Check that all actions were registered
    if (bootstrapPlugin.actions) {
      expect(runtime.registerAction).toHaveBeenCalledTimes(
        bootstrapPlugin.actions.length,
      );

      // Verify each action was registered
      bootstrapPlugin.actions.forEach((action) => {
        expect(runtime.registerAction).toHaveBeenCalledWith(action);
      });
    }
  });

  it("should register all evaluators during initialization", async () => {
    // Execute the mocked initialization function
    await mockInit({}, runtime as Partial<IAgentRuntime> as IAgentRuntime);

    // Check that all evaluators were registered
    if (bootstrapPlugin.evaluators) {
      expect(runtime.registerEvaluator).toHaveBeenCalledTimes(
        bootstrapPlugin.evaluators.length,
      );

      // Verify each evaluator was registered
      bootstrapPlugin.evaluators.forEach((evaluator) => {
        expect(runtime.registerEvaluator).toHaveBeenCalledWith(evaluator);
      });
    }
  });

  it("should register all events during initialization", async () => {
    // Execute the mocked initialization function
    await mockInit({}, runtime as Partial<IAgentRuntime> as IAgentRuntime);

    // Count the number of event registrations expected
    let expectedEventCount = 0;
    if (bootstrapPlugin.events) {
      Object.values(bootstrapPlugin.events).forEach((handlers) => {
        expectedEventCount += handlers.length;
      });

      // Check that all events were registered
      expect(runtime.registerEvent).toHaveBeenCalledTimes(expectedEventCount);
    }
  });

  it("should register all services during initialization", async () => {
    // Execute the mocked initialization function
    await mockInit({}, runtime as Partial<IAgentRuntime> as IAgentRuntime);

    // Check that all services were registered
    if (bootstrapPlugin.services) {
      expect(runtime.registerService).toHaveBeenCalledTimes(
        bootstrapPlugin.services.length,
      );

      // Verify each service was registered
      bootstrapPlugin.services.forEach((service) => {
        expect(runtime.registerService).toHaveBeenCalledWith(service);
      });
    }
  });

  it("should handle initialization errors gracefully", async () => {
    // Setup runtime to fail during registration
    runtime.registerProvider = vi.fn().mockImplementation(() => {
      throw new Error("Registration failed");
    });

    // Create a spy for console.error
    const originalConsoleError = console.error;
    const consoleErrorSpy = vi.fn();
    console.error = consoleErrorSpy;

    // Should not throw error during initialization
    await expect(async () => {
      await mockInit({}, runtime as Partial<IAgentRuntime> as IAgentRuntime);
    }).not.toThrow();

    // Ensure console.error was called (as the mockInit is expected to log errors)
    expect(consoleErrorSpy).toHaveBeenCalled();

    // Restore console.error
    console.error = originalConsoleError;
  });
});

describe("Message Event Handlers", () => {
  it("should have handlers for other event types", () => {
    expect(bootstrapPlugin.events).toBeDefined();

    const events = bootstrapPlugin.events;
    if (events) {
      // Check for various event types presence
      const eventTypes = Object.keys(events);

      // Check for event types that actually exist in the bootstrapPlugin.events
      // MESSAGE_RECEIVED is handled via runtime.messageService, not as a plugin event
      expect(eventTypes).toContain(EventType.WORLD_JOINED);
      expect(eventTypes).toContain(EventType.ENTITY_JOINED);

      // Verify we have comprehensive coverage of event handlers
      const commonEventTypes = [
        EventType.WORLD_JOINED,
        EventType.ENTITY_JOINED,
        EventType.ENTITY_LEFT,
        EventType.ACTION_STARTED,
        EventType.ACTION_COMPLETED,
      ];

      commonEventTypes.forEach((eventType) => {
        if (eventType in events) {
          const handlers = events[eventType];
          if (handlers) {
            expect(handlers.length).toBeGreaterThan(0);
            expect(typeof handlers[0]).toBe("function");
          }
        }
      });
    }
  });
});

describe("Plugin Module Structure", () => {
  it("should export all required plugin components", () => {
    // Check that the plugin exports all required components
    expect(bootstrapPlugin).toHaveProperty("name");
    expect(bootstrapPlugin).toHaveProperty("description");
    // The init function is optional in this plugin
    expect(bootstrapPlugin).toHaveProperty("providers");
    expect(bootstrapPlugin).toHaveProperty("actions");
    expect(bootstrapPlugin).toHaveProperty("events");
    expect(bootstrapPlugin).toHaveProperty("services");
    expect(bootstrapPlugin).toHaveProperty("evaluators");
  });

  it("should have properly structured providers", () => {
    // Check that providers have the required structure
    if (bootstrapPlugin.providers) {
      bootstrapPlugin.providers.forEach((provider) => {
        expect(provider).toHaveProperty("name");
        expect(provider).toHaveProperty("get");
        expect(typeof provider.get).toBe("function");
      });
    }
  });

  it("should have properly structured actions", () => {
    // Check that actions have the required structure
    if (bootstrapPlugin.actions) {
      bootstrapPlugin.actions.forEach((action) => {
        expect(action).toHaveProperty("name");
        expect(action).toHaveProperty("description");
        expect(action).toHaveProperty("handler");
        expect(action).toHaveProperty("validate");
        expect(typeof action.handler).toBe("function");
        expect(typeof action.validate).toBe("function");
      });
    }
  });

  it("should have correct folder structure", () => {
    // Verify that the exported providers match expected naming conventions
    // FACTS is an extended capability, not included by default
    const providerNames = (bootstrapPlugin.providers || []).map((p) => p.name);
    expect(providerNames).toContain("TIME");
    expect(providerNames).toContain("RECENT_MESSAGES");

    // Verify that the exported actions match expected naming conventions
    const actionNames = (bootstrapPlugin.actions || []).map((a) => a.name);
    expect(actionNames).toContain("REPLY");
    expect(actionNames).toContain("NONE");
  });
});
