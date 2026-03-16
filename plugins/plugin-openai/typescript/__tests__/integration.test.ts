/**
 * Integration tests for the OpenAI plugin.
 * These tests use real API calls and skip if OPENAI_API_KEY is not set.
 */

import { describe, expect, it } from "vitest";

const API_KEY = process.env.OPENAI_API_KEY;
const skipIfNoApiKey = API_KEY ? it : it.skip;

describe("OpenAI Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export openaiPlugin", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin).toBeDefined();
      expect(openaiPlugin.name).toBe("openai");
    });

    it("should have correct description", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.description).toContain("OpenAI");
    });

    it("should have models defined", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models).toBeDefined();
      expect(Object.keys(openaiPlugin.models ?? {}).length).toBeGreaterThan(0);
    });

    it("should have init function", async () => {
      const { openaiPlugin } = await import("../index");
      expect(typeof openaiPlugin.init).toBe("function");
    });

    it("should have tests defined", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.tests).toBeDefined();
      expect(Array.isArray(openaiPlugin.tests)).toBe(true);
    });
  });

  describe("Configuration", () => {
    it("should have all config keys", async () => {
      const { openaiPlugin } = await import("../index");
      const config = openaiPlugin.config;
      expect(config).toHaveProperty("OPENAI_API_KEY");
      expect(config).toHaveProperty("OPENAI_BASE_URL");
      expect(config).toHaveProperty("OPENAI_SMALL_MODEL");
      expect(config).toHaveProperty("OPENAI_LARGE_MODEL");
      expect(config).toHaveProperty("OPENAI_RESEARCH_MODEL");
      expect(config).toHaveProperty("OPENAI_RESEARCH_TIMEOUT");
    });
  });

  describe("Model Handlers", () => {
    it("should have TEXT_EMBEDDING handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_EMBEDDING).toBeDefined();
    });

    it("should have TEXT_SMALL handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_SMALL).toBeDefined();
    });

    it("should have TEXT_LARGE handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_LARGE).toBeDefined();
    });

    it("should have IMAGE handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.IMAGE).toBeDefined();
    });

    it("should have TEXT_TOKENIZER_ENCODE handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_TOKENIZER_ENCODE).toBeDefined();
    });

    it("should have TEXT_TOKENIZER_DECODE handler", async () => {
      const { openaiPlugin } = await import("../index");
      expect(openaiPlugin.models?.TEXT_TOKENIZER_DECODE).toBeDefined();
    });
  });

  describe("Tokenization (no API key required)", () => {
    it("should encode text to tokens", async () => {
      const { handleTokenizerEncode } = await import("../models/tokenizer");

      // Mock runtime with minimal config
      const mockRuntime = {
        getSetting: (key: string) => {
          if (key === "OPENAI_SMALL_MODEL") return "gpt-5-mini";
          return undefined;
        },
        character: {},
      };

      const tokens = await handleTokenizerEncode(mockRuntime as never, {
        prompt: "Hello, world!",
        modelType: "TEXT_SMALL" as never,
      });

      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
    });

    it("should decode tokens back to text", async () => {
      const { handleTokenizerEncode, handleTokenizerDecode } = await import("../models/tokenizer");

      const mockRuntime = {
        getSetting: (key: string) => {
          if (key === "OPENAI_SMALL_MODEL") return "gpt-5-mini";
          return undefined;
        },
        character: {},
      };

      const originalText = "Hello, world!";
      const tokens = await handleTokenizerEncode(mockRuntime as never, {
        prompt: originalText,
        modelType: "TEXT_SMALL" as never,
      });

      const decoded = await handleTokenizerDecode(mockRuntime as never, {
        tokens,
        modelType: "TEXT_SMALL" as never,
      });

      expect(decoded).toBe(originalText);
    });
  });

  describe("API Tests (skip if no API key)", () => {
    skipIfNoApiKey("should be able to connect to API", async () => {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
      });

      expect(response.ok).toBe(true);
    });
  });
});
