/**
 * @fileoverview Tests for inference provider detection
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectInferenceProviders,
  hasInferenceProvider,
  requireInferenceProvider,
} from "../testing/inference-provider";

describe("Inference Provider Detection", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  describe("detectInferenceProviders", () => {
    it("should detect OpenAI when API key is set", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";

      // Mock Ollama as unavailable
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const result = await detectInferenceProviders();

      expect(result.hasProvider).toBe(true);
      const resultPrimaryProvider = result.primaryProvider;
      expect(resultPrimaryProvider?.name).toBe("openai");
      expect(resultPrimaryProvider?.available).toBe(true);
    });

    it("should detect Anthropic when API key is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const result = await detectInferenceProviders();

      expect(result.hasProvider).toBe(true);
      const anthropic = result.allProviders.find((p) => p.name === "anthropic");
      expect(anthropic?.available).toBe(true);
    });

    it("should detect Google when API key is set", async () => {
      process.env.GOOGLE_API_KEY = "test-google-key";

      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const result = await detectInferenceProviders();

      expect(result.hasProvider).toBe(true);
      const google = result.allProviders.find((p) => p.name === "google");
      expect(google?.available).toBe(true);
    });

    it("should detect Ollama when available", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: "llama3.2:1b" }, { name: "nomic-embed-text" }],
        }),
      } as Response);

      const result = await detectInferenceProviders();

      expect(result.hasProvider).toBe(true);
      const ollama = result.allProviders.find((p) => p.name === "ollama");
      expect(ollama?.available).toBe(true);
      expect(ollama?.models).toEqual(["llama3.2:1b", "nomic-embed-text"]);
    });

    it("should handle Ollama returning error status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const result = await detectInferenceProviders();

      const ollama = result.allProviders.find((p) => p.name === "ollama");
      expect(ollama?.available).toBe(false);
      expect(ollama?.error).toBe("Ollama returned status 500");
    });

    it("should handle Ollama network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await detectInferenceProviders();

      const ollama = result.allProviders.find((p) => p.name === "ollama");
      expect(ollama?.available).toBe(false);
      expect(ollama?.error).toBe("ECONNREFUSED");
    });

    it("should handle Ollama invalid response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => "not an object",
      } as Response);

      const result = await detectInferenceProviders();

      const ollama = result.allProviders.find((p) => p.name === "ollama");
      expect(ollama?.available).toBe(false);
      expect(ollama?.error).toContain("Invalid response from Ollama");
    });

    it("should report no provider when none available", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const result = await detectInferenceProviders();

      expect(result.hasProvider).toBe(false);
      expect(result.primaryProvider).toBe(null);
      expect(result.summary).toContain("NO INFERENCE PROVIDER AVAILABLE");
    });

    it("should prefer cloud providers over Ollama", async () => {
      process.env.OPENAI_API_KEY = "sk-test";

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "llama3.2:1b" }] }),
      } as Response);

      const result = await detectInferenceProviders();

      // OpenAI should be primary even though Ollama is also available
      const resultPrimaryProvider = result.primaryProvider;
      expect(resultPrimaryProvider?.name).toBe("openai");
    });
  });

  describe("hasInferenceProvider", () => {
    it("should return true when provider is available", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const result = await hasInferenceProvider();
      expect(result).toBe(true);
    });

    it("should return false when no provider is available", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const result = await hasInferenceProvider();
      expect(result).toBe(false);
    });
  });

  describe("requireInferenceProvider", () => {
    it("should return provider when available", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      const provider = await requireInferenceProvider();
      expect(provider.name).toBe("anthropic");
      expect(provider.available).toBe(true);
    });

    it("should throw when no provider is available", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));

      await expect(requireInferenceProvider()).rejects.toThrow(
        "No inference provider available for integration tests",
      );
    });
  });
});
