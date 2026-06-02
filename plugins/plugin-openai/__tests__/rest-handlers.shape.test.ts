import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextEmbedding } from "../models/embedding";
import { handleImageDescription } from "../models/image";
import { getTTSModel } from "../utils/config";

function createRuntime(settings: Record<string, string> = {}) {
  return {
    character: { name: "Ada" },
    emitEvent: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn((key: string) => {
      const values: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        ...settings,
      };
      return values[key];
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI REST handler request shapes", () => {
  it("sends explicit embedding dimensions and keeps mismatch validation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: new Array(384).fill(0.1), index: 0 }],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const embedding = await handleTextEmbedding(
      createRuntime({ OPENAI_EMBEDDING_DIMENSIONS: "384" }),
      { text: "hello" }
    );

    expect(embedding).toHaveLength(384);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(requestBody).toMatchObject({
      model: "text-embedding-3-small",
      input: "hello",
      dimensions: 384,
    });
  });

  it("fails when provider embedding dimensions do not match the requested dimensions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              object: "list",
              data: [{ object: "embedding", embedding: new Array(1536).fill(0.1), index: 0 }],
              model: "text-embedding-3-small",
              usage: { prompt_tokens: 4, total_tokens: 4 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      ) as typeof fetch
    );

    await expect(
      handleTextEmbedding(createRuntime({ OPENAI_EMBEDDING_DIMENSIONS: "384" }), "hello")
    ).rejects.toThrow("Embedding dimension mismatch");
  });

  it("lets image-description params override configured max tokens", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "gpt-5-mini",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Title: Test image\nDescription: A test image.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(createRuntime({ OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS: "999" }), {
        imageUrl: "https://example.com/image.png",
        prompt: "Describe it",
        maxTokens: 123,
      } as never)
    ).resolves.toMatchObject({
      title: "Test image",
      description: expect.stringContaining("A test image."),
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(requestBody.max_tokens).toBe(123);
  });

  it("keeps the runtime TTS default aligned with package metadata", () => {
    expect(getTTSModel(createRuntime())).toBe("gpt-5-mini-tts");
  });
});
