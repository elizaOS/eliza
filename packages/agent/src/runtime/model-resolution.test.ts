/**
 * Coverage for model-resolution helpers: primary model id extraction,
 * provider id resolution across transport/backend combinations, and plugin
 * name mapping. @elizaos/shared helpers are mocked to keep the suite
 * deterministic and dependency-free.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirstRunProviderOption: vi.fn(),
  normalizeFirstRunProviderId: vi.fn(),
  resolveServiceRoutingInConfig: vi.fn(),
}));

vi.mock("@elizaos/shared", () => ({
  getFirstRunProviderOption: mocks.getFirstRunProviderOption,
  normalizeFirstRunProviderId: mocks.normalizeFirstRunProviderId,
  resolveServiceRoutingInConfig: mocks.resolveServiceRoutingInConfig,
}));

type ModelResolutionModule = {
  resolvePreferredProviderId: (config: unknown) => string | undefined;
  resolvePreferredProviderPluginName: (config: unknown) => string | undefined;
  resolvePrimaryModel: (config: unknown) => string | undefined;
};

async function loadModelResolution(): Promise<ModelResolutionModule> {
  vi.resetModules();
  return import("./model-resolution.ts");
}

beforeEach(() => {
  mocks.getFirstRunProviderOption.mockReset();
  mocks.normalizeFirstRunProviderId.mockReset();
  mocks.resolveServiceRoutingInConfig.mockReset();
});

describe("resolvePrimaryModel", () => {
  it("returns undefined when no model config exists", async () => {
    const mod = await loadModelResolution();
    expect(mod.resolvePrimaryModel({})).toBeUndefined();
    expect(mod.resolvePrimaryModel({ agents: {} })).toBeUndefined();
  });

  it("returns the primary model id when configured", async () => {
    const mod = await loadModelResolution();
    const config = {
      agents: { defaults: { model: { primary: "deepseek-chat" } } },
    };
    expect(mod.resolvePrimaryModel(config)).toBe("deepseek-chat");
  });
});

describe("resolvePreferredProviderId", () => {
  it("returns elizacloud for a cloud-proxy transport", async () => {
    mocks.resolveServiceRoutingInConfig.mockReturnValue({
      llmText: { transport: "cloud-proxy", backend: "elizacloud" },
    });
    mocks.normalizeFirstRunProviderId.mockImplementation((v: string) => v);
    const mod = await loadModelResolution();
    expect(mod.resolvePreferredProviderId({})).toBe("elizacloud");
  });

  it("returns the direct backend when not elizacloud", async () => {
    mocks.resolveServiceRoutingInConfig.mockReturnValue({
      llmText: { transport: "direct", backend: "anthropic" },
    });
    mocks.normalizeFirstRunProviderId.mockImplementation((v: string) => v);
    const mod = await loadModelResolution();
    expect(mod.resolvePreferredProviderId({})).toBe("anthropic");
  });

  it("falls back to the model-name hint for a direct transport without backend", async () => {
    mocks.resolveServiceRoutingInConfig.mockReturnValue({
      llmText: { transport: "direct", primaryModel: "openai/gpt-4o" },
    });
    mocks.normalizeFirstRunProviderId.mockImplementation((v: string) =>
      v === "openai/gpt-4o" ? "openai" : undefined,
    );
    const mod = await loadModelResolution();
    expect(mod.resolvePreferredProviderId({})).toBe("openai");
  });

  it("returns undefined when nothing is configured", async () => {
    mocks.resolveServiceRoutingInConfig.mockReturnValue(undefined);
    mocks.normalizeFirstRunProviderId.mockReturnValue(undefined);
    const mod = await loadModelResolution();
    expect(mod.resolvePreferredProviderId({})).toBeUndefined();
  });
});

describe("resolvePreferredProviderPluginName", () => {
  it("maps a resolved provider id to its plugin name", async () => {
    mocks.resolveServiceRoutingInConfig.mockReturnValue({
      llmText: { transport: "direct", backend: "anthropic" },
    });
    mocks.normalizeFirstRunProviderId.mockImplementation((v: string) => v);
    mocks.getFirstRunProviderOption.mockReturnValue({
      pluginName: "@elizaos/plugin-anthropic",
    });
    const mod = await loadModelResolution();
    expect(mod.resolvePreferredProviderPluginName({})).toBe(
      "@elizaos/plugin-anthropic",
    );
  });

  it("returns undefined when no provider is resolved", async () => {
    mocks.resolveServiceRoutingInConfig.mockReturnValue(undefined);
    mocks.normalizeFirstRunProviderId.mockReturnValue(undefined);
    const mod = await loadModelResolution();
    expect(mod.resolvePreferredProviderPluginName({})).toBeUndefined();
  });
});
