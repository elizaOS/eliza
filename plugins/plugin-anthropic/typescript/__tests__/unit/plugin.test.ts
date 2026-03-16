/**
 * Unit tests for the Anthropic plugin structure.
 *
 * These tests verify the plugin exports and structure without making API calls.
 */

import { describe, expect, it } from "vitest";

describe("Anthropic Plugin Structure", () => {
  it("should export anthropicPlugin with correct structure", async () => {
    const { anthropicPlugin } = await import("../../index");

    expect(anthropicPlugin).toBeDefined();
    expect(anthropicPlugin.name).toBe("anthropic");
    expect(anthropicPlugin.description).toContain("Anthropic");
    expect(anthropicPlugin.config).toBeDefined();
    expect(anthropicPlugin.models).toBeDefined();
    expect(anthropicPlugin.init).toBeDefined();
    expect(typeof anthropicPlugin.init).toBe("function");
  });

  it("should have all required model handlers", async () => {
    const { anthropicPlugin } = await import("../../index");
    const { ModelType } = await import("@elizaos/core");

    expect(anthropicPlugin.models).toBeDefined();
    expect(anthropicPlugin.models?.[ModelType.TEXT_SMALL]).toBeDefined();
    expect(anthropicPlugin.models?.[ModelType.TEXT_LARGE]).toBeDefined();
    expect(anthropicPlugin.models?.[ModelType.OBJECT_SMALL]).toBeDefined();
    expect(anthropicPlugin.models?.[ModelType.OBJECT_LARGE]).toBeDefined();
  });

  it("should have config with expected environment variables", async () => {
    const { anthropicPlugin } = await import("../../index");

    const config = anthropicPlugin.config as Record<string, unknown>;
    expect(config).toHaveProperty("ANTHROPIC_API_KEY");
    expect(config).toHaveProperty("ANTHROPIC_SMALL_MODEL");
    expect(config).toHaveProperty("ANTHROPIC_LARGE_MODEL");
  });

  it("should export types", async () => {
    const types = await import("../../types");

    expect(types.assertValidApiKey).toBeDefined();
    expect(types.createModelName).toBeDefined();
    expect(types.isReflectionSchema).toBeDefined();
  });

  it("should export utility functions", async () => {
    const utils = await import("../../utils");

    expect(utils.getApiKey).toBeDefined();
    expect(utils.getSmallModel).toBeDefined();
    expect(utils.getLargeModel).toBeDefined();
    expect(utils.getBaseURL).toBeDefined();
    expect(utils.extractAndParseJSON).toBeDefined();
    expect(utils.ensureReflectionProperties).toBeDefined();
  });
});

describe("Configuration Utilities", () => {
  it("should provide default model names", async () => {
    const { getSmallModel, getLargeModel } = await import("../../utils/config");

    // Create a mock runtime that returns undefined for all settings
    const agentRuntime = {
      getSetting: () => undefined,
    };

    const smallModel = getSmallModel(agentRuntime as never);
    const largeModel = getLargeModel(agentRuntime as never);

    expect(smallModel).toBe("claude-3-5-haiku-20241022");
    expect(largeModel).toBe("claude-sonnet-4-20250514");
  });

  it("should allow overriding model names via settings", async () => {
    const { getSmallModel, getLargeModel } = await import("../../utils/config");

    const agentRuntime = {
      getSetting: (key: string) => {
        if (key === "ANTHROPIC_SMALL_MODEL") return "custom-small";
        if (key === "ANTHROPIC_LARGE_MODEL") return "custom-large";
        return undefined;
      },
    };

    const smallModel = getSmallModel(agentRuntime as never);
    const largeModel = getLargeModel(agentRuntime as never);

    expect(smallModel).toBe("custom-small");
    expect(largeModel).toBe("custom-large");
  });

  it("should detect browser environment correctly", async () => {
    const { isBrowser } = await import("../../utils/config");

    // In Node/Bun test environment, this should be false
    expect(isBrowser()).toBe(false);
  });
});

describe("Type Guards", () => {
  it("should correctly identify reflection schemas", async () => {
    const { isReflectionSchema } = await import("../../types");

    expect(isReflectionSchema(undefined)).toBe(false);
    expect(isReflectionSchema({})).toBe(false);
    expect(isReflectionSchema({ type: "object" })).toBe(false);
    expect(isReflectionSchema({ facts: [], relationships: [] })).toBe(true);
  });

  it("should validate API keys", async () => {
    const { assertValidApiKey } = await import("../../types");

    expect(() => assertValidApiKey(undefined)).toThrow();
    expect(() => assertValidApiKey("")).toThrow();
    expect(() => assertValidApiKey("   ")).toThrow();
    expect(() => assertValidApiKey("valid-key")).not.toThrow();
  });

  it("should create valid model names", async () => {
    const { createModelName } = await import("../../types");

    expect(() => createModelName("")).toThrow();
    expect(() => createModelName("   ")).toThrow();
    expect(createModelName("claude-3-5-haiku")).toBe("claude-3-5-haiku");
  });
});
