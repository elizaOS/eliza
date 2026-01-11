/**
 * @fileoverview Tests for LLM Mode and checkShouldRespond settings
 *
 * These tests verify that the new runtime settings work correctly:
 * - LLMMode (DEFAULT, SMALL, LARGE) for overriding model selection
 * - checkShouldRespond for enabling/disabling response evaluation
 */

import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { createTestCharacter } from "../testing/test-helpers";
import type { IDatabaseAdapter } from "../types";
import { LLMMode, ModelType } from "../types";

/**
 * Minimal mock adapter for testing AgentRuntime.
 * Uses a Proxy to return mock implementations for all methods.
 */
function createMinimalMockAdapter(): IDatabaseAdapter {
  const mockCache: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy({} as IDatabaseAdapter, {
    get: (_target, prop) => {
      if (prop === "db") return {};
      const propStr = String(prop);
      if (!mockCache[propStr]) {
        mockCache[propStr] = vi.fn().mockResolvedValue(null);
      }
      return mockCache[propStr];
    },
  });
}

describe("LLMMode Settings", () => {
  describe("getLLMMode", () => {
    it("should return DEFAULT by default", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
      });
      expect(runtime.getLLMMode()).toBe("DEFAULT");
    });

    it("should return constructor option when provided", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        llmMode: LLMMode.SMALL,
      });
      expect(runtime.getLLMMode()).toBe("SMALL");
    });

    it("should return LARGE when constructor option is LARGE", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        llmMode: LLMMode.LARGE,
      });
      expect(runtime.getLLMMode()).toBe("LARGE");
    });

    it("should use character setting when constructor option not provided", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { LLM_MODE: "SMALL" },
        }),
      });
      expect(runtime.getLLMMode()).toBe("SMALL");
    });

    it("should prefer constructor option over character setting", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { LLM_MODE: "SMALL" },
        }),
        llmMode: LLMMode.LARGE,
      });
      expect(runtime.getLLMMode()).toBe("LARGE");
    });

    it("should handle case-insensitive character settings", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { LLM_MODE: "small" },
        }),
      });
      expect(runtime.getLLMMode()).toBe("SMALL");
    });

    it("should return DEFAULT for invalid character setting", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { LLM_MODE: "invalid" },
        }),
      });
      expect(runtime.getLLMMode()).toBe("DEFAULT");
    });
  });

  describe("useModel with LLMMode override", () => {
    it("should not override when LLMMode is DEFAULT", async () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        llmMode: LLMMode.DEFAULT,
        adapter: createMinimalMockAdapter(),
      });

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async () => "large response",
        "test",
      );
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () => "small response",
        "test",
      );

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "test",
      });
      expect(result).toBe("large response");
    });

    it("should override TEXT_LARGE to TEXT_SMALL when LLMMode is SMALL", async () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        llmMode: LLMMode.SMALL,
        adapter: createMinimalMockAdapter(),
      });

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async () => "large response",
        "test",
      );
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () => "small response",
        "test",
      );

      // Request TEXT_LARGE but should get TEXT_SMALL due to override
      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "test",
      });
      expect(result).toBe("small response");
    });

    it("should override TEXT_SMALL to TEXT_LARGE when LLMMode is LARGE", async () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        llmMode: LLMMode.LARGE,
        adapter: createMinimalMockAdapter(),
      });

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async () => "large response",
        "test",
      );
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () => "small response",
        "test",
      );

      // Request TEXT_SMALL but should get TEXT_LARGE due to override
      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "test",
      });
      expect(result).toBe("large response");
    });

    it("should not override non-text-generation models", async () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        llmMode: LLMMode.SMALL,
        adapter: createMinimalMockAdapter(),
      });

      runtime.registerModel(
        ModelType.TEXT_EMBEDDING,
        async () => [0.1, 0.2, 0.3],
        "test",
      );

      // Embedding model should not be overridden
      const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: "test",
      });
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });
  });
});

describe("checkShouldRespond Settings", () => {
  describe("isCheckShouldRespondEnabled", () => {
    it("should return true by default", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
      });
      expect(runtime.isCheckShouldRespondEnabled()).toBe(true);
    });

    it("should return false when constructor option is false", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        checkShouldRespond: false,
      });
      expect(runtime.isCheckShouldRespondEnabled()).toBe(false);
    });

    it("should return true when constructor option is true", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        checkShouldRespond: true,
      });
      expect(runtime.isCheckShouldRespondEnabled()).toBe(true);
    });

    it("should use character setting when constructor option not provided", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { CHECK_SHOULD_RESPOND: "false" },
        }),
      });
      expect(runtime.isCheckShouldRespondEnabled()).toBe(false);
    });

    it("should prefer constructor option over character setting", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { CHECK_SHOULD_RESPOND: "false" },
        }),
        checkShouldRespond: true,
      });
      expect(runtime.isCheckShouldRespondEnabled()).toBe(true);
    });

    it("should handle string 'false' character settings", () => {
      // getSetting uses || chains so boolean false would be skipped - use string "false"
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { CHECK_SHOULD_RESPOND: "false" },
        }),
      });
      expect(runtime.isCheckShouldRespondEnabled()).toBe(false);
    });

    it("should default to true for non-false string values", () => {
      const runtime = new AgentRuntime({
        character: createTestCharacter({
          settings: { CHECK_SHOULD_RESPOND: "yes" },
        }),
      });
      // Only "false" should disable it
      expect(runtime.isCheckShouldRespondEnabled()).toBe(true);
    });
  });
});

describe("LLMMode enum values", () => {
  it("should have correct string values", () => {
    expect(LLMMode.DEFAULT).toBe("DEFAULT");
    expect(LLMMode.SMALL).toBe("SMALL");
    expect(LLMMode.LARGE).toBe("LARGE");
  });
});
