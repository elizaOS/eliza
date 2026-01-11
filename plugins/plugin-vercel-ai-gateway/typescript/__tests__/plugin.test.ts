/**
 * Unit tests for Vercel AI Gateway plugin.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayPlugin } from "../index";

// Mock runtime
const createMockRuntime = (settings: Record<string, string> = {}): IAgentRuntime => {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    useModel: vi.fn(),
  } as unknown as IAgentRuntime;
};

describe("gatewayPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct plugin metadata", () => {
    expect(gatewayPlugin.name).toBe("gateway");
    expect(gatewayPlugin.description).toContain("Vercel AI Gateway");
  });

  it("should have config keys defined", () => {
    expect(gatewayPlugin.config).toBeDefined();
    expect(gatewayPlugin.config?.AI_GATEWAY_API_KEY).toBeDefined();
  });

  it("should have model handlers registered", () => {
    expect(gatewayPlugin.models).toBeDefined();
    const models = gatewayPlugin.models;

    // Check that handlers are registered
    expect(models?.TEXT_SMALL).toBeDefined();
    expect(models?.TEXT_LARGE).toBeDefined();
    expect(models?.TEXT_EMBEDDING).toBeDefined();
    expect(models?.IMAGE).toBeDefined();
    expect(models?.IMAGE_DESCRIPTION).toBeDefined();
    expect(models?.OBJECT_SMALL).toBeDefined();
    expect(models?.OBJECT_LARGE).toBeDefined();
  });

  it("should have test suite defined", () => {
    expect(gatewayPlugin.tests).toBeDefined();
    expect(Array.isArray(gatewayPlugin.tests)).toBe(true);
    expect(gatewayPlugin.tests?.length).toBeGreaterThan(0);
  });

  it("should initialize without error when API key is present", async () => {
    const agentRuntime = createMockRuntime({
      AI_GATEWAY_API_KEY: "test-key",
    });

    await expect(gatewayPlugin.init?.({}, agentRuntime)).resolves.not.toThrow();
  });
});

describe("configuration utilities", () => {
  it("should read API key from multiple sources", async () => {
    const { getApiKeyOptional } = await import("../utils/config");

    // Test with AI_GATEWAY_API_KEY
    const runtime1 = createMockRuntime({ AI_GATEWAY_API_KEY: "key1" });
    expect(getApiKeyOptional(runtime1)).toBe("key1");

    // Test with AIGATEWAY_API_KEY
    const runtime2 = createMockRuntime({ AIGATEWAY_API_KEY: "key2" });
    expect(getApiKeyOptional(runtime2)).toBe("key2");

    // Test with VERCEL_OIDC_TOKEN
    const runtime3 = createMockRuntime({ VERCEL_OIDC_TOKEN: "token" });
    expect(getApiKeyOptional(runtime3)).toBe("token");
  });

  it("should use default values when not configured", async () => {
    const { getBaseUrl, getSmallModel, getLargeModel, getEmbeddingModel } = await import(
      "../utils/config"
    );

    const runtime = createMockRuntime({});

    expect(getBaseUrl(runtime)).toBe("https://ai-gateway.vercel.sh/v1");
    expect(getSmallModel(runtime)).toBe("gpt-5-mini");
    expect(getLargeModel(runtime)).toBe("gpt-5");
    expect(getEmbeddingModel(runtime)).toBe("text-embedding-3-small");
  });

  it("should override defaults when configured", async () => {
    const { getSmallModel, getLargeModel } = await import("../utils/config");

    const runtime = createMockRuntime({
      AI_GATEWAY_SMALL_MODEL: "custom-small",
      AI_GATEWAY_LARGE_MODEL: "custom-large",
    });

    expect(getSmallModel(runtime)).toBe("custom-small");
    expect(getLargeModel(runtime)).toBe("custom-large");
  });
});
