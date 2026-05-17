import type { Content, HandlerCallback, IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { starterPlugin } from "../index";
import { cleanupTestRuntime, createTestRuntime, setupLoggerSpies } from "./test-utils";

beforeAll(() => {
  setupLoggerSpies();
});

describe("Integration: HelloWorld Action", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime({ skipInitialize: true });
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should handle HelloWorld action", async () => {
    const helloWorldAction = starterPlugin.actions?.find((action) => action.name === "HELLO_WORLD");
    if (!helloWorldAction) {
      throw new Error("Hello world action not found");
    }

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

    const callbackCalls: [Content][] = [];
    const callbackFn: HandlerCallback = async (content: Content) => {
      callbackCalls.push([content]);
      return [];
    };

    await helloWorldAction.handler(runtime, mockMessage, mockState, {}, callbackFn, []);

    expect(callbackCalls.length).toBeGreaterThan(0);
    const firstCall = callbackCalls[0];
    if (!firstCall) {
      throw new Error("Hello world action did not call the handler callback");
    }
    expect(firstCall[0].text).toBe("Hello world!");
    expect(firstCall[0].actions).toEqual(["HELLO_WORLD"]);
    expect(firstCall[0].source).toBe("test");
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
