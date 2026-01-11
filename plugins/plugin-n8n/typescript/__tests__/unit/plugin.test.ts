/**
 * Unit tests for the N8n Plugin.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { n8nPlugin } from "../../index";
import {
  createPluginAction,
  checkPluginCreationStatusAction,
  cancelPluginCreationAction,
} from "../../actions/plugin-creation-actions";
import {
  pluginCreationStatusProvider,
  pluginCreationCapabilitiesProvider,
} from "../../providers/plugin-creation-providers";

const createMockRuntime = (): IAgentRuntime => {
  return {
    getSetting: vi.fn(),
    services: new Map(),
    providers: new Map(),
    actions: new Map(),
    evaluators: new Map(),
  } as unknown as IAgentRuntime;
};

const createMockMemory = (text: string): Memory =>
  ({
    id: crypto.randomUUID(),
    content: { text },
    userId: "test-user",
    roomId: "test-room",
    entityId: "test-entity",
    createdAt: Date.now(),
  }) as Memory;

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
  let mockRuntime: IAgentRuntime;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockState = { values: {}, data: {}, text: "" };
    vi.clearAllMocks();
  });

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
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    vi.clearAllMocks();
  });

  it("should be properly defined", () => {
    expect(checkPluginCreationStatusAction).toBeDefined();
    expect(checkPluginCreationStatusAction.name).toBe(
      "checkPluginCreationStatus"
    );
  });
});

describe("cancelPluginCreationAction", () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    vi.clearAllMocks();
  });

  it("should be properly defined", () => {
    expect(cancelPluginCreationAction).toBeDefined();
    expect(cancelPluginCreationAction.name).toBe("cancelPluginCreation");
  });
});

describe("pluginCreationStatusProvider", () => {
  let mockRuntime: IAgentRuntime;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockState = { values: {}, data: {}, text: "" };
    vi.clearAllMocks();
  });

  it("should be properly defined", () => {
    expect(pluginCreationStatusProvider).toBeDefined();
    expect(pluginCreationStatusProvider.name).toBe("plugin_creation_status");
  });

  it("should return service not available when no service", async () => {
    const message = createMockMemory("test");
    const result = await pluginCreationStatusProvider.get(
      mockRuntime,
      message,
      mockState
    );
    expect(result.text).toContain("not available");
  });
});

describe("pluginCreationCapabilitiesProvider", () => {
  let mockRuntime: IAgentRuntime;
  let mockState: State;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockState = { values: {}, data: {}, text: "" };
    vi.clearAllMocks();
  });

  it("should be properly defined", () => {
    expect(pluginCreationCapabilitiesProvider).toBeDefined();
    expect(pluginCreationCapabilitiesProvider.name).toBe(
      "plugin_creation_capabilities"
    );
  });

  it("should return service not available when no service", async () => {
    const message = createMockMemory("test");
    const result = await pluginCreationCapabilitiesProvider.get(
      mockRuntime,
      message,
      mockState
    );
    expect(result.text).toContain("not available");
  });
});


