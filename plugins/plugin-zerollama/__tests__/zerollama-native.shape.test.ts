/**
 * Unit tests for zerollama host detection and native `/api/chat` body shaping.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOllamaHostFlavorCache,
  resolveOllamaHostFlavor,
  setOllamaHostFlavorForTest,
} from "../utils/host-flavor";
import {
  buildZerollamaChatBody,
  toZerollamaChatMessages,
  toZerollamaTools,
  zerollamaChatComplete,
  zerollamaChatStream,
  zerollamaEmbed,
} from "../utils/zerollama-native";

describe("resolveOllamaHostFlavor", () => {
  afterEach(() => {
    clearOllamaHostFlavorCache();
    delete process.env.OLLAMA_HOST_FLAVOR;
  });

  it("classifies distribution=zerollama from /api/version", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        distribution: "zerollama",
        version: "1cedb56-dirty",
        zerollama: { capabilities: {} },
      })
    );
    await expect(
      resolveOllamaHostFlavor("http://192.168.255.164:8080/api", fetchImpl as typeof fetch)
    ).resolves.toBe("zerollama");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.255.164:8080/api/version",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("honours OLLAMA_HOST_FLAVOR override without probing", async () => {
    process.env.OLLAMA_HOST_FLAVOR = "zerollama";
    const fetchImpl = vi.fn();
    await expect(
      resolveOllamaHostFlavor("http://host:11434/api", fetchImpl as typeof fetch)
    ).resolves.toBe("zerollama");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches flavors per API base", async () => {
    setOllamaHostFlavorForTest("http://host:11434", "ollama");
    const fetchImpl = vi.fn();
    await expect(
      resolveOllamaHostFlavor("http://host:11434/api", fetchImpl as typeof fetch)
    ).resolves.toBe("ollama");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("zerollama native wire helpers", () => {
  it("builds ChatRequest without top-level temperature/max_output_tokens/tool_choice", () => {
    const body = buildZerollamaChatBody({
      model: "eliza-1:9b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.7,
      maxTokens: 1024,
      tools: [
        {
          type: "function",
          function: { name: "ping", parameters: { type: "object" } },
        },
      ],
    });
    expect(body).toEqual({
      model: "eliza-1:9b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      think: false,
      tools: [
        {
          type: "function",
          function: { name: "ping", parameters: { type: "object" } },
        },
      ],
      options: { temperature: 0.7, num_predict: 1024 },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("maps ToolSet jsonSchema wrappers into Ollama tool definitions", () => {
    const tools = toZerollamaTools({
      lookup: {
        description: "Lookup",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      },
    } as never);
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("builds chat messages from prompt + system", () => {
    expect(
      toZerollamaChatMessages({
        system: "you are helpful",
        prompt: "hi",
      })
    ).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("forwards cancellation to native complete and streaming requests", async () => {
    const controller = new AbortController();
    const completeFetch = vi.fn(async () =>
      Response.json({ message: { content: "ok" }, done: true })
    );
    const body = buildZerollamaChatBody({
      model: "qwen3:0.6b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });

    await zerollamaChatComplete({
      apiBase: "http://host:11434",
      body,
      fetchImpl: completeFetch as typeof fetch,
      promptForEstimate: "hi",
      modelName: "qwen3:0.6b",
      signal: controller.signal,
    });
    expect(completeFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    const encoder = new TextEncoder();
    const streamFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(
                encoder.encode('{"message":{"content":"ok"},"done":true}\n')
              );
              streamController.close();
            },
          })
        )
    );
    const result = zerollamaChatStream({
      apiBase: "http://host:11434",
      body,
      fetchImpl: streamFetch as typeof fetch,
      promptForEstimate: "hi",
      modelName: "qwen3:0.6b",
      signal: controller.signal,
    });
    for await (const _chunk of result.textStream) {
      // Drain the real native stream wrapper so its fetch executes.
    }
    expect(streamFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("posts /api/embed with model+input only", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: "embeddinggemma:300m",
        embeddings: [[0.1, 0.2, 0.3]],
      })
    );
    const vector = await zerollamaEmbed({
      apiBase: "http://192.168.255.164:8080",
      model: "embeddinggemma:300m",
      input: "hello",
      fetchImpl: fetchImpl as typeof fetch,
      signal: controller.signal,
    });
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.255.164:8080/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "embeddinggemma:300m",
          input: "hello",
        }),
        signal: controller.signal,
      })
    );
  });

  it("coerces object input and falls back to /v1/embeddings when /api/embed is empty", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/embed")) {
        return Response.json({ model: "embeddinggemma:300m", embeddings: [] });
      }
      return Response.json({
        data: [{ embedding: [0.4, 0.5] }],
      });
    });
    const vector = await zerollamaEmbed({
      apiBase: "http://host:8080",
      model: "embeddinggemma:300m",
      input: { text: "hello" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(vector).toEqual([0.4, 0.5]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://host:8080/api/embed",
      expect.objectContaining({
        body: JSON.stringify({
          model: "embeddinggemma:300m",
          input: "hello",
        }),
      })
    );
  });
});
