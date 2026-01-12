import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayPlugin } from "../index";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("gatewayPlugin", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
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
    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "AI_GATEWAY_API_KEY") return "test-key";
      return null;
    });

    await expect(gatewayPlugin.init?.({}, runtime)).resolves.not.toThrow();
  });
});

describe("configuration utilities", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should read API key from multiple sources", async () => {
    const { getApiKeyOptional } = await import("../utils/config");

    // Test with AI_GATEWAY_API_KEY
    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "AI_GATEWAY_API_KEY") return "key1";
      return null;
    });
    expect(getApiKeyOptional(runtime)).toBe("key1");
  });

  it("should use default values when not configured", async () => {
    const { getBaseUrl, getSmallModel, getLargeModel, getEmbeddingModel } = await import(
      "../utils/config"
    );

    vi.spyOn(runtime, "getSetting").mockReturnValue(null);

    expect(getBaseUrl(runtime)).toBe("https://ai-gateway.vercel.sh/v1");
    expect(getSmallModel(runtime)).toBe("gpt-5-mini");
    expect(getLargeModel(runtime)).toBe("gpt-5");
    expect(getEmbeddingModel(runtime)).toBe("text-embedding-3-small");
  });

  it("should override defaults when configured", async () => {
    const { getSmallModel, getLargeModel } = await import("../utils/config");

    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      const settings: Record<string, string> = {
        AI_GATEWAY_SMALL_MODEL: "custom-small",
        AI_GATEWAY_LARGE_MODEL: "custom-large",
      };
      return settings[key] || null;
    });

    expect(getSmallModel(runtime)).toBe("custom-small");
    expect(getLargeModel(runtime)).toBe("custom-large");
  });
});
