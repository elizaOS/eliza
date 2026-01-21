/**
 * Agent LLM Provider Tests
 *
 * Tests all code paths for:
 * - Ollama (local)
 * - HuggingFace (cloud)
 * - Phala (cloud)
 * - Groq (default)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { TrajectoryLoggerService } from "../../plugins/plugin-trajectory-logger/src/TrajectoryLoggerService";

// Mock fetch globally
const originalFetch = globalThis.fetch;

describe("Agent LLM Provider", () => {
  // Store original env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env vars
    delete process.env.AGENT_LLM_PROVIDER;
    delete process.env.HUGGINGFACE_API_KEY;
    delete process.env.HUGGINGFACE_MODEL_ENDPOINT;
    delete process.env.PHALA_ENDPOINT;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
  });

  afterEach(() => {
    // Restore env vars
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  describe("getAgentLLMStatus", () => {
    it("returns groq as default provider", async () => {
      const { getAgentLLMStatus } = await import("../agent-llm");
      const status = await getAgentLLMStatus();

      expect(status.provider).toBe("groq");
    });

    it("detects huggingface provider", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      process.env.HUGGINGFACE_API_KEY = "test-key";
      process.env.HUGGINGFACE_MODEL_ENDPOINT = "https://test.endpoint";

      // Re-import to pick up new env vars
      const { getAgentLLMStatus } = await import("../agent-llm");
      const status = await getAgentLLMStatus();

      expect(status.provider).toBe("huggingface");
      expect(status.configured).toBe(true);
      expect(status.details.hasApiKey).toBe(true);
    });

    it("detects ollama provider", async () => {
      process.env.AGENT_LLM_PROVIDER = "ollama";

      const { getAgentLLMStatus } = await import("../agent-llm");
      const status = await getAgentLLMStatus();

      expect(status.provider).toBe("ollama");
      expect(status.configured).toBe(true);
      expect(status.details.endpoint).toBe("http://localhost:11434");
    });

    it('accepts "local" as alias for ollama', async () => {
      process.env.AGENT_LLM_PROVIDER = "local";

      const { getAgentLLMStatus } = await import("../agent-llm");
      const status = await getAgentLLMStatus();

      expect(status.provider).toBe("ollama");
    });

    it('accepts "hf" as alias for huggingface', async () => {
      process.env.AGENT_LLM_PROVIDER = "hf";

      const { getAgentLLMStatus } = await import("../agent-llm");
      const status = await getAgentLLMStatus();

      expect(status.provider).toBe("huggingface");
    });
  });

  describe("callAgentLLM - Ollama", () => {
    it("calls Ollama API correctly", async () => {
      process.env.AGENT_LLM_PROVIDER = "ollama";
      process.env.OLLAMA_BASE_URL = "http://localhost:11434";

      // Mock fetch
      const mockResponse = {
        message: { content: "Test response from Ollama" },
        prompt_eval_count: 10,
        eval_count: 20,
      };

      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        expect(url).toBe("http://localhost:11434/api/chat");
        expect(options.method).toBe("POST");

        const body = JSON.parse(options.body as string);
        expect(body.model).toBe("qwen2.5:7b-instruct");
        expect(body.stream).toBe(false);
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0].role).toBe("system");
        expect(body.messages[1].role).toBe("user");

        return new Response(JSON.stringify(mockResponse), { status: 200 });
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Test prompt",
        system: "Test system",
        temperature: 0.7,
        maxTokens: 1000,
      });

      expect(result).toBe("Test response from Ollama");
    });

    it("uses archetype-specific model when provided", async () => {
      process.env.AGENT_LLM_PROVIDER = "ollama";
      process.env.OLLAMA_BASE_URL = "http://localhost:11434";

      // Mock both the tags API (model listing) and chat API
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        if (url.includes("/api/tags")) {
          // Return available models including the archetype model
          return new Response(
            JSON.stringify({
              models: [
                { name: "polyagent-trader:latest", size: 1000000 },
                { name: "qwen2.5:7b-instruct", size: 2000000 },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes("/api/chat")) {
          const body = JSON.parse(options.body as string);
          expect(body.model).toBe("polyagent-trader:latest");
          return new Response(
            JSON.stringify({
              message: { content: "Trader response" },
            }),
            { status: 200 },
          );
        }

        return new Response("Not found", { status: 404 });
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Trade decision",
        archetype: "trader",
      });

      expect(result).toBe("Trader response");
    });

    it("falls back to base model if archetype model not found", async () => {
      process.env.AGENT_LLM_PROVIDER = "ollama";
      process.env.OLLAMA_BASE_URL = "http://localhost:11434";

      // Mock: archetype model not available, but base model is
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        if (url.includes("/api/tags")) {
          // Return only base model (no archetype-specific model)
          return new Response(
            JSON.stringify({
              models: [{ name: "qwen2.5:7b-instruct", size: 2000000 }],
            }),
            { status: 200 },
          );
        }

        if (url.includes("/api/chat")) {
          const body = JSON.parse(options.body as string);
          // Should fall back to base model
          expect(body.model).toBe("qwen2.5:7b-instruct");
          return new Response(
            JSON.stringify({
              message: { content: "Fallback response" },
            }),
            { status: 200 },
          );
        }

        return new Response("Not found", { status: 404 });
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Trade decision",
        archetype: "trader",
      });

      expect(result).toBe("Fallback response");
    });
  });

  describe("callAgentLLM - HuggingFace", () => {
    it("calls HuggingFace Inference API correctly", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      process.env.HUGGINGFACE_API_KEY = "test-api-key";
      process.env.HUGGINGFACE_MODEL_ENDPOINT =
        "https://api.huggingface.co/models/test";
      process.env.HUGGINGFACE_API_FORMAT = "inference";

      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        expect(url).toBe("https://api.huggingface.co/models/test");
        expect(options.method).toBe("POST");
        expect(options.headers).toEqual({
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        });

        const body = JSON.parse(options.body as string);
        expect(body.inputs).toHaveLength(2);
        expect(body.parameters.temperature).toBe(0.7);
        expect(body.parameters.max_new_tokens).toBe(1000);

        return new Response(
          JSON.stringify([{ generated_text: "HuggingFace response" }]),
          { status: 200 },
        );
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Test prompt",
        system: "Test system",
        temperature: 0.7,
        maxTokens: 1000,
      });

      expect(result).toBe("HuggingFace response");
    });

    it("calls HuggingFace OpenAI-compatible endpoint correctly", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      process.env.HUGGINGFACE_API_KEY = "test-api-key";
      process.env.HUGGINGFACE_MODEL_ENDPOINT = "https://my-model.hf.space";
      process.env.HUGGINGFACE_API_FORMAT = "openai";

      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        expect(url).toBe("https://my-model.hf.space/v1/chat/completions");

        const body = JSON.parse(options.body as string);
        expect(body.model).toBe("polyagent-trader");
        expect(body.messages).toHaveLength(2);
        expect(body.temperature).toBe(0.7);
        expect(body.max_tokens).toBe(1000);

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "OpenAI-format response" } }],
          }),
          { status: 200 },
        );
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Test prompt",
        system: "Test system",
        archetype: "trader",
        temperature: 0.7,
        maxTokens: 1000,
      });

      expect(result).toBe("OpenAI-format response");
    });

    it("handles HuggingFace single object response format", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      process.env.HUGGINGFACE_API_KEY = "test-key";
      process.env.HUGGINGFACE_MODEL_ENDPOINT = "https://test.endpoint";
      delete process.env.HUGGINGFACE_API_FORMAT;

      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            generated_text: "Single object response",
          }),
          { status: 200 },
        );
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Test",
      });

      expect(result).toBe("Single object response");
    });

    it("throws error if API key not set", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      delete process.env.HUGGINGFACE_API_KEY;

      const { callAgentLLM } = await import("../agent-llm");

      await expect(callAgentLLM({ prompt: "Test" })).rejects.toThrow(
        "HUGGINGFACE_API_KEY not set",
      );
    });

    it("throws error if endpoint not set", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      process.env.HUGGINGFACE_API_KEY = "test-key";
      delete process.env.HUGGINGFACE_MODEL_ENDPOINT;

      const { callAgentLLM } = await import("../agent-llm");

      await expect(callAgentLLM({ prompt: "Test" })).rejects.toThrow(
        "HUGGINGFACE_MODEL_ENDPOINT not set",
      );
    });

    it("handles HuggingFace API errors", async () => {
      process.env.AGENT_LLM_PROVIDER = "huggingface";
      process.env.HUGGINGFACE_API_KEY = "test-key";
      process.env.HUGGINGFACE_MODEL_ENDPOINT = "https://test.endpoint";

      globalThis.fetch = mock(async () => {
        return new Response("Rate limit exceeded", { status: 429 });
      });

      const { callAgentLLM } = await import("../agent-llm");

      await expect(callAgentLLM({ prompt: "Test" })).rejects.toThrow(
        "HuggingFace API error: 429",
      );
    });
  });

  describe("callAgentLLM - Phala", () => {
    it("calls Phala API correctly", async () => {
      process.env.AGENT_LLM_PROVIDER = "phala";
      process.env.PHALA_ENDPOINT = "https://phala.test/v1/chat";

      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        expect(url).toBe("https://phala.test/v1/chat");
        expect(options.method).toBe("POST");

        const body = JSON.parse(options.body as string);
        expect(body.model).toBe("polyagent-trader");
        expect(body.messages).toHaveLength(2);
        expect(body.temperature).toBe(0.8);

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Phala TEE response" } }],
          }),
          { status: 200 },
        );
      });

      const { callAgentLLM } = await import("../agent-llm");
      const result = await callAgentLLM({
        prompt: "Test",
        system: "System",
        archetype: "trader",
        temperature: 0.8,
      });

      expect(result).toBe("Phala TEE response");
    });

    it("throws error if endpoint not set", async () => {
      process.env.AGENT_LLM_PROVIDER = "phala";

      const { callAgentLLM } = await import("../agent-llm");

      await expect(callAgentLLM({ prompt: "Test" })).rejects.toThrow(
        "PHALA_ENDPOINT not set",
      );
    });
  });

  describe("callAgentLLM - Groq (default)", () => {
    it("falls back to Groq when no provider set", async () => {
      // Don't set AGENT_LLM_PROVIDER - should default to groq
      process.env.GROQ_API_KEY = "test-groq-key";

      const { getAgentLLMStatus } = await import("../agent-llm");
      const status = await getAgentLLMStatus();

      expect(status.provider).toBe("groq");
      expect(status.configured).toBe(true);
    });
  });

  describe("Trajectory Logging", () => {
    it("logs LLM calls to trajectory when logger available", async () => {
      process.env.AGENT_LLM_PROVIDER = "ollama";

      const mockLogger = {
        getCurrentStepId: mock(() => "step-123"),
        logLLMCall: mock(() => {}),
      };

      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            message: { content: "Response" },
            prompt_eval_count: 50,
            eval_count: 100,
          }),
          { status: 200 },
        );
      });

      const { callAgentLLM } = await import("../agent-llm");
      await callAgentLLM({
        prompt: "Test prompt",
        system: "Test system",
        purpose: "action",
        actionType: "trade",
        trajectoryLogger: mockLogger as unknown as TrajectoryLoggerService,
        trajectoryId: "traj-456",
      });

      expect(mockLogger.getCurrentStepId).toHaveBeenCalledWith("traj-456");
      expect(mockLogger.logLLMCall).toHaveBeenCalledWith(
        "step-123",
        expect.objectContaining({
          model: "qwen2.5:7b-instruct",
          systemPrompt: "Test system",
          userPrompt: "Test prompt",
          response: "Response",
          purpose: "action",
          actionType: "trade",
          promptTokens: 50,
          completionTokens: 100,
        }),
      );
    });
  });
});
