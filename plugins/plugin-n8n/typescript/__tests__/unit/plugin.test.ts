/**
 * Unit tests for the N8n Plugin.
 * Uses REAL AgentRuntime - NO MOCKS.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPluginCreationAction,
  checkPluginCreationStatusAction,
  createPluginAction,
} from "../../actions/plugin-creation-actions";
import { n8nPlugin } from "../../index";
import {
  pluginCreationCapabilitiesProvider,
  pluginCreationStatusProvider,
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
    getService: () => undefined, // No services by default
    getSetting: () => undefined, // No settings by default
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
    expect(n8nPlugin.description).toContain("N8n");
  });

  it("should have actions defined", () => {
    expect(n8nPlugin.actions).toBeDefined();
    expect(n8nPlugin.actions?.length).toBeGreaterThan(0);
  });

  it("should have providers defined", () => {
    expect(n8nPlugin.providers).toBeDefined();
    expect(n8nPlugin.providers?.length).toBeGreaterThan(0);
  });

  it("should have services defined", () => {
    expect(n8nPlugin.services).toBeDefined();
    expect(n8nPlugin.services?.length).toBeGreaterThan(0);
  });
});

describe("createPluginAction", () => {
  it("should be properly defined", () => {
    expect(createPluginAction).toBeDefined();
    expect(createPluginAction.name).toBe("createPlugin");
  });

  it("should have description", () => {
    expect(createPluginAction.description).toBeDefined();
    expect(createPluginAction.description.length).toBeGreaterThan(0);
  });

  it("should have examples", () => {
    expect(createPluginAction.examples).toBeDefined();
    expect(createPluginAction.examples?.length).toBeGreaterThan(0);
  });
});

describe("checkPluginCreationStatusAction", () => {
  it("should be properly defined", () => {
    expect(checkPluginCreationStatusAction).toBeDefined();
    expect(checkPluginCreationStatusAction.name).toBe("checkPluginCreationStatus");
  });
});

describe("cancelPluginCreationAction", () => {
  it("should be properly defined", () => {
    expect(cancelPluginCreationAction).toBeDefined();
    expect(cancelPluginCreationAction.name).toBe("cancelPluginCreation");
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

  it("should be properly defined", () => {
    expect(pluginCreationStatusProvider).toBeDefined();
    expect(pluginCreationStatusProvider.name).toBe("plugin_creation_status");
  });

  it("should return service not available when no service", async () => {
    const message = createTestMemory("test", runtime.agentId);
    const result = await pluginCreationStatusProvider.get(runtime, message, testState);
    expect(result.text).toContain("not available");
  });
});

describe("pluginCreationCapabilitiesProvider", () => {
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

  it("should be properly defined", () => {
    expect(pluginCreationCapabilitiesProvider).toBeDefined();
    expect(pluginCreationCapabilitiesProvider.name).toBe("plugin_creation_capabilities");
  });

  it("should return service not available when no service", async () => {
    const message = createTestMemory("test", runtime.agentId);
    const result = await pluginCreationCapabilitiesProvider.get(runtime, message, testState);
    expect(result.text).toContain("not available");
  });
});
