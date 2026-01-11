/**
 * @fileoverview Tests for Ollama provider
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOllamaModelHandlers,
  isOllamaAvailable,
  listOllamaModels,
} from "../testing/ollama-provider";
import { ModelType } from "../types";

describe("Ollama Provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("isOllamaAvailable", () => {
    it("should return true when Ollama responds OK", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
      } as Response);

      const result = await isOllamaAvailable();
      expect(result).toBe(true);
    });

    it("should return false when Ollama returns error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const result = await isOllamaAvailable();
      expect(result).toBe(false);
    });

    it("should return false on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await isOllamaAvailable();
      expect(result).toBe(false);
    });
  });

  describe("listOllamaModels", () => {
    it("should return list of model names", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: "llama3.2:1b" },
            { name: "llama3.2:3b" },
            { name: "nomic-embed-text" },
          ],
        }),
      } as Response);

      const models = await listOllamaModels();
      expect(models).toEqual([
        "llama3.2:1b",
        "llama3.2:3b",
        "nomic-embed-text",
      ]);
    });

    it("should return empty array when no models", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      const models = await listOllamaModels();
      expect(models).toEqual([]);
    });

    it("should throw on error response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(listOllamaModels()).rejects.toThrow(
        "Ollama returned status 500",
      );
    });

    it("should throw on invalid response structure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => "not an object",
      } as Response);

      await expect(listOllamaModels()).rejects.toThrow(
        "Invalid Ollama response",
      );
    });
  });

  describe("createOllamaModelHandlers", () => {
    it("should return handlers for all supported model types", () => {
      const handlers = createOllamaModelHandlers();

      expect(handlers[ModelType.TEXT_SMALL]).toBeDefined();
      expect(handlers[ModelType.TEXT_LARGE]).toBeDefined();
      expect(handlers[ModelType.TEXT_EMBEDDING]).toBeDefined();
      expect(handlers[ModelType.OBJECT_SMALL]).toBeDefined();
      expect(handlers[ModelType.OBJECT_LARGE]).toBeDefined();
    });

    describe("TEXT_SMALL handler", () => {
      it("should call Ollama generate API", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ response: "Hello, I am a test response" }),
        } as Response);
        globalThis.fetch = mockFetch;

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.TEXT_SMALL];

        const agentRuntime = {
          character: { system: "You are a test agent" },
        };

        const result = await handler?.(agentRuntime as never, {
          prompt: "Hello",
        });
        expect(result).toBe("Hello, I am a test response");

        // Verify the fetch was called with correct params
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toContain("/api/generate");

        const body = JSON.parse(callArgs[1].body);
        expect(body.prompt).toBe("Hello");
        expect(body.system).toBe("You are a test agent");
      });
    });

    describe("TEXT_EMBEDDING handler", () => {
      it("should call Ollama embed API", async () => {
        const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ embeddings: [embedding] }),
        } as Response);

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.TEXT_EMBEDDING];

        const agentRuntime = { character: {} };
        const result = await handler?.(agentRuntime as never, {
          text: "Test text",
        });

        expect(result).toEqual(embedding);
      });

      it("should handle single embedding response format", async () => {
        const embedding = [0.1, 0.2, 0.3];
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ embedding }),
        } as Response);

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.TEXT_EMBEDDING];

        const agentRuntime = { character: {} };
        const result = await handler?.(agentRuntime as never, {
          text: "Test text",
        });

        expect(result).toEqual(embedding);
      });

      it("should throw when no embeddings returned", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        } as Response);

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.TEXT_EMBEDDING];

        const agentRuntime = { character: {} };
        await expect(
          handler?.(agentRuntime as never, { text: "Test text" }),
        ).rejects.toThrow("No embeddings returned from Ollama");
      });
    });

    describe("OBJECT_SMALL handler", () => {
      it("should extract JSON from response", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            response: 'Here is the JSON: {"name": "test", "value": 42}',
          }),
        } as Response);

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.OBJECT_SMALL];

        const agentRuntime = { character: {} };
        const result = await handler?.(agentRuntime as never, {
          prompt: "Generate JSON",
        });

        expect(result).toEqual({ name: "test", value: 42 });
      });

      it("should throw on invalid JSON", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            response: "This is not valid JSON at all",
          }),
        } as Response);

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.OBJECT_SMALL];

        const agentRuntime = { character: {} };
        await expect(
          handler?.(agentRuntime as never, { prompt: "Generate JSON" }),
        ).rejects.toThrow("Failed to parse JSON from Ollama response");
      });

      it("should use lower temperature for structured output", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ response: '{"result": true}' }),
        } as Response);
        globalThis.fetch = mockFetch;

        const handlers = createOllamaModelHandlers();
        const handler = handlers[ModelType.OBJECT_SMALL];

        const agentRuntime = { character: {} };
        await handler?.(agentRuntime as never, { prompt: "Generate JSON" });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.options.temperature).toBe(0.3);
      });
    });
  });
});
