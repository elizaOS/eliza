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
  ZerollamaHttpError,
  zerollamaChatComplete,
  zerollamaChatStream,
  zerollamaEmbed,
  zerollamaEmbedMany,
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

  it("rejects a native completion that stopped at its output boundary", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        message: { content: "partial" },
        done: true,
        done_reason: "length",
      })
    );
    const body = buildZerollamaChatBody({
      model: "qwen3:0.6b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });

    await expect(
      zerollamaChatComplete({
        apiBase: "http://host:11434",
        body,
        fetchImpl: fetchImpl as typeof fetch,
        promptForEstimate: "hi",
        modelName: "qwen3:0.6b",
      })
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  });

  it("signals a native stream output-boundary stop after its final delta", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  '{"message":{"content":"partial"},"done":false}\n' +
                    '{"done":true,"done_reason":"length"}\n'
                )
              );
              controller.close();
            },
          })
        )
    );
    const body = buildZerollamaChatBody({
      model: "qwen3:0.6b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const result = zerollamaChatStream({
      apiBase: "http://host:11434",
      body,
      fetchImpl: fetchImpl as typeof fetch,
      promptForEstimate: "hi",
      modelName: "qwen3:0.6b",
    });
    const chunks: string[] = [];

    await expect(async () => {
      for await (const chunk of result.textStream) chunks.push(chunk);
    }).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
    expect(chunks).toEqual(["partial"]);
    await expect(result.text).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
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

describe("zerollamaEmbedMany error-message truncation", () => {
  /** Body whose last surrogate pair straddles `limit` so a naive slice would split it. */
  const straddlingBody = (limit: number): string => `${"x".repeat(limit - 1)}\u{1F600}tail`;

  const textResponse = (status: number, body: string): Response =>
    new Response(body, { status, headers: { "Content-Type": "text/plain" } });

  it("keeps /api/embed 5xx messages well-formed at the 300-unit cap and retains the raw body", async () => {
    const raw = straddlingBody(300);
    const fetchImpl = vi.fn(async () => textResponse(500, raw));
    const error = await zerollamaEmbedMany({
      apiBase: "http://host:8080",
      model: "embeddinggemma:300m",
      input: "hello",
      fetchImpl: fetchImpl as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZerollamaHttpError);
    const httpError = error as ZerollamaHttpError;
    expect(httpError.message.isWellFormed()).toBe(true);
    expect(httpError.message).toContain("x".repeat(299));
    expect(httpError.message).not.toContain("\u{1F600}");
    expect(httpError.message).not.toContain("tail");
    expect(httpError.responseBody).toBe(raw);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the dual-route failure message well-formed at both 160-unit caps", async () => {
    const nativeRaw = straddlingBody(160);
    const v1Raw = `${"y".repeat(159)}\u{1F600}v1tail`;
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith("/api/embed") ? textResponse(400, nativeRaw) : textResponse(502, v1Raw)
    );
    const error = await zerollamaEmbedMany({
      apiBase: "http://host:8080",
      model: "embeddinggemma:300m",
      input: "hello",
      fetchImpl: fetchImpl as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZerollamaHttpError);
    const httpError = error as ZerollamaHttpError;
    expect(httpError.message.isWellFormed()).toBe(true);
    expect(httpError.message).toContain("x".repeat(159));
    expect(httpError.message).toContain("y".repeat(159));
    expect(httpError.message).not.toContain("\u{1F600}");
    expect(httpError.message).not.toContain("tail");
    expect(httpError.statusCode).toBe(502);
    expect(httpError.responseBody).toBe(v1Raw);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the empty-embedding message well-formed at the 120-unit cap", async () => {
    const nativeRaw = straddlingBody(120);
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith("/api/embed")
        ? textResponse(400, nativeRaw)
        : Response.json({ data: [{ embedding: [] }] })
    );
    const error = await zerollamaEmbedMany({
      apiBase: "http://host:8080",
      model: "embeddinggemma:300m",
      input: "hello",
      fetchImpl: fetchImpl as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ZerollamaHttpError);
    const message = (error as Error).message;
    expect(message.isWellFormed()).toBe(true);
    expect(message).toContain("returned an empty embedding");
    expect(message).toContain("x".repeat(119));
    expect(message).not.toContain("\u{1F600}");
    expect(message).not.toContain("tail");
  });
});
