/**
 * Unit tests for the N8n Plugin.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPluginCreationAction,
  checkPluginCreationStatusAction,
  createPluginAction,
  createPluginFromDescriptionAction,
} from "../../actions/plugin-creation-actions";
import { n8nPlugin } from "../../index";
import {
  pluginCreationStatusProvider,
  pluginRegistryProvider,
} from "../../providers/plugin-creation-providers";

function createMockRuntime(): {
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
} {
  const agentId = "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`;

  const runtime = {
    agentId,
    character: {
      name: "Test Agent",
      bio: ["A test agent"],
      system: "You are a helpful assistant.",
    },
    getService: () => undefined,
    getSetting: () => undefined,
    services: new Map(),
  } as unknown as IAgentRuntime;

  const cleanup = async () => {};

  return { runtime, cleanup };
}

function createTestMemory(text: string, agentId: string): Memory {
  return {
    id: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
    content: { text },
    userId: "test-user" as `${string}-${string}-${string}-${string}-${string}`,
    roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
    entityId: "test-entity" as `${string}-${string}-${string}-${string}-${string}`,
    agentId: agentId as `${string}-${string}-${string}-${string}-${string}`,
    createdAt: Date.now(),
  } as Memory;
}

describe("n8nPlugin", () => {
  it("should be properly defined", () => {
    expect(n8nPlugin).toBeDefined();
    expect(n8nPlugin.name).toBe("@elizaos/plugin-n8n");
  });

  it("should have correct description", () => {
    expect(n8nPlugin.description).toContain("n8n");
  });

  it("should have 9 actions defined", () => {
    expect(n8nPlugin.actions).toBeDefined();
    expect(n8nPlugin.actions?.length).toBe(9);
  });

  it("should have 3 providers defined", () => {
    expect(n8nPlugin.providers).toBeDefined();
    expect(n8nPlugin.providers?.length).toBe(3);
  });

  it("should have 3 services defined", () => {
    expect(n8nPlugin.services).toBeDefined();
    expect(n8nPlugin.services?.length).toBe(3);
  });
});

describe("createPluginAction", () => {
  it("should have correct name", () => {
    expect(createPluginAction).toBeDefined();
    expect(createPluginAction.name).toBe("CREATE_PLUGIN");
  });

  it("should have description with when-to-use guidance", () => {
    expect(createPluginAction.description).toBeDefined();
    expect(createPluginAction.description).toContain("Do NOT");
    expect(createPluginAction.description.length).toBeGreaterThan(50);
  });

  it("should have examples", () => {
    expect(createPluginAction.examples).toBeDefined();
    expect(createPluginAction.examples?.length).toBeGreaterThanOrEqual(3);
  });

  it("should have similes", () => {
    expect(createPluginAction.similes).toBeDefined();
    expect(createPluginAction.similes?.length).toBeGreaterThan(0);
  });
});

describe("checkPluginCreationStatusAction", () => {
  it("should have correct name", () => {
    expect(checkPluginCreationStatusAction).toBeDefined();
    expect(checkPluginCreationStatusAction.name).toBe("CHECK_PLUGIN_STATUS");
  });

  it("should have description with when-to-use guidance", () => {
    expect(checkPluginCreationStatusAction.description).toContain("Do NOT");
  });
});

describe("cancelPluginCreationAction", () => {
  it("should have correct name", () => {
    expect(cancelPluginCreationAction).toBeDefined();
    expect(cancelPluginCreationAction.name).toBe("CANCEL_PLUGIN");
  });
});

describe("createPluginFromDescriptionAction", () => {
  it("should have correct name", () => {
    expect(createPluginFromDescriptionAction).toBeDefined();
    expect(createPluginFromDescriptionAction.name).toBe("DESCRIBE_PLUGIN");
  });

  it("should have description with when-to-use guidance", () => {
    expect(createPluginFromDescriptionAction.description).toContain("Do NOT");
  });
});

describe("pluginCreationStatusProvider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testState: State;

  beforeEach(() => {
    const result = createMockRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;
    testState = { values: {}, data: {}, text: "" };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should have correct name", () => {
    expect(pluginCreationStatusProvider).toBeDefined();
    expect(pluginCreationStatusProvider.name).toBe("n8n_plugin_status");
  });

  it("should return empty when no service", async () => {
    const message = createTestMemory("test", runtime.agentId);
    const result = await pluginCreationStatusProvider.get(runtime, message, testState);
    expect(result.text).toBe("");
  });
});

describe("pluginRegistryProvider", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testState: State;

  beforeEach(() => {
    const result = createMockRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;
    testState = { values: {}, data: {}, text: "" };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should have correct name", () => {
    expect(pluginRegistryProvider).toBeDefined();
    expect(pluginRegistryProvider.name).toBe("n8n_plugin_registry");
  });

  it("should return empty when no service", async () => {
    const message = createTestMemory("test", runtime.agentId);
    const result = await pluginRegistryProvider.get(runtime, message, testState);
    expect(result.text).toBe("");
  });
});
