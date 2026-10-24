import { AgentRuntime, EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBatchTextEmbedding, handleTextEmbedding } from "../src/models/embedding";

const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

type EmbeddingRequest = {
  input: string | string[];
};

const requestBodies: string[] = [];

function buildRuntime(): AgentRuntime {
  return new AgentRuntime({
    logLevel: "fatal",
    settings: {
      EMBEDDING_BASE_URL: "https://embedding.test",
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "test-model",
      EMBEDDING_DIMENSIONS: "384",
    },
    plugins: [],
  });
}

beforeEach(() => {
  requestBodies.length = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      requestBodies.push(body);

      const parsed = JSON.parse(body) as EmbeddingRequest;
      const count = Array.isArray(parsed.input) ? parsed.input.length : 1;

      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, (_, index) => ({
            index,
            embedding: Array.from({ length: 384 }, (_, dimension) => (dimension === 0 ? 1 : 0)),
          })),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#18025: embedding request bodies are well-formed JSON", () => {
  it("sanitizes single and batch inputs at the wire boundary", async () => {
    const runtime = buildRuntime();
    const broken = "summarize this page 🤖 please".slice(0, 21);
    const fullEmoji = "full emoji 🤖";
    const plainText = "plain text";

    expect(broken).toContain("\uD83E");
    expect(LONE_SURROGATE_ESCAPE.test(JSON.stringify(broken))).toBe(true);

    await handleTextEmbedding(runtime, broken);
    await handleBatchTextEmbedding(runtime, [broken, fullEmoji, plainText]);

    expect(requestBodies).toHaveLength(2);

    const single = JSON.parse(requestBodies[0]) as EmbeddingRequest;
    const batch = JSON.parse(requestBodies[1]) as EmbeddingRequest;

    expect(single.input).toBe("summarize this page �");
    expect(batch.input).toEqual(["summarize this page �", fullEmoji, plainText]);
    expect(single.input).toContain("\uFFFD");

    for (const body of requestBodies) {
      expect(LONE_SURROGATE_ESCAPE.test(body)).toBe(false);
    }
  });
});

describe("embedding usage events report listener failures", () => {
  it("serves the embedding and reports a rejected MODEL_USED listener", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  index: 0,
                  embedding: Array.from({ length: 384 }, (_, dimension) =>
                    dimension === 0 ? 1 : 0
                  ),
                },
              ],
              usage: { prompt_tokens: 3, total_tokens: 3 },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const runtime = buildRuntime();
    runtime.registerEvent(EventType.MODEL_USED, async () => {
      throw new Error("MODEL_USED listener failed");
    });

    await expect(handleTextEmbedding(runtime, "remember this")).resolves.toHaveLength(384);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getRecentReportedErrors()).toContainEqual(
      expect.objectContaining({
        scope: "EmbeddingsModelUsage.emitEvent",
        message: "MODEL_USED listener failed",
      })
    );
  });
});
