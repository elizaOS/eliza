/** Exercises TEI identity admission, canonical input preparation and vector validation at a real HTTP boundary. */
import { afterEach, expect, test } from "bun:test";
import { BGE_SMALL_VECTOR_SPACE } from "@elizaos/common";
import { prepareBgeEmbeddingInput } from "@elizaos/shared/local-inference/bge-input";
import { embedMany } from "ai";
import { isKnownUnacceptedProviderError } from "../services/inference-provider-outcome";
import { createTeiEmbeddingModel } from "./tei-embeddings";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));
const info = {
  model_id: "BAAI/bge-small-en-v1.5",
  model_sha: null,
  model_type: { embedding: { pooling: "cls" } },
  max_input_length: 512,
};

test("TEI receives the canonical source tail and returns normalized named vectors", async () => {
  const requests: unknown[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture");
      if (new URL(request.url).pathname === "/info") return Response.json(info);
      const body = await request.json();
      requests.push(body);
      return Response.json([[3, 4, ...Array(382).fill(0)]]);
    },
  });
  const source = `old ${"word ".repeat(520)}critical ending`;
  const model = createTeiEmbeddingModel(`${server.url}v1`, "fixture");
  const result = await embedMany({ model, values: [source], maxRetries: 0 });
  expect(requests).toEqual([
    { inputs: [prepareBgeEmbeddingInput(source).text], normalize: true, truncate: false },
  ]);
  expect(model.embeddingSpace).toBe(BGE_SMALL_VECTOR_SPACE);
  expect(result.embeddings[0]).toHaveLength(384);
  expect(result.embeddings[0]?.[0]).toBeCloseTo(0.6);
  expect(result.usage.tokens).toBe(prepareBgeEmbeddingInput(source).tokenIds.length);
});

test.each([
  { ...info, model_id: "thenlper/gte-small" },
  { ...info, model_type: { embedding: { pooling: "mean" } } },
  { ...info, model_sha: "another-revision" },
])("rejects incompatible TEI before sending source text", async (identity) => {
  let embeds = 0;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/info") return Response.json(identity);
      embeds++;
      return Response.json([]);
    },
  });
  await expect(
    embedMany({
      model: createTeiEmbeddingModel(String(server.url), "fixture"),
      values: ["source"],
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ code: "EMBEDDING_PROVIDER_IDENTITY_MISMATCH" });
  expect(embeds).toBe(0);
  try {
    await embedMany({
      model: createTeiEmbeddingModel(String(server.url), "fixture"),
      values: ["source"],
      maxRetries: 0,
    });
    throw new Error("expected rejection");
  } catch (error) {
    expect(isKnownUnacceptedProviderError(error)).toBe(true);
  }
});

test.each([{ vectors: [[1, 2, 3]] }, { vectors: [Array(384).fill(0)] }, { vectors: [] }])(
  "rejects invalid vectors",
  async ({ vectors }) => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        return Response.json(new URL(request.url).pathname === "/info" ? info : vectors);
      },
    });
    await expect(
      embedMany({
        model: createTeiEmbeddingModel(String(server.url), "fixture"),
        values: ["source"],
        maxRetries: 0,
      }),
    ).rejects.toThrow();
  },
);

test("a backend identity change between batches preserves accepted-prefix accounting", async () => {
  let checks = 0;
  let embeds = 0;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/info") {
        checks++;
        return Response.json(checks === 1 ? info : { ...info, model_id: "thenlper/gte-small" });
      }
      embeds++;
      const body = await request.json();
      return Response.json(body.inputs.map(() => [1, ...Array(383).fill(0)]));
    },
  });
  let failure: unknown;
  try {
    await embedMany({
      model: createTeiEmbeddingModel(String(server.url), "fixture"),
      values: Array(101).fill("source"),
      maxRetries: 2,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "EMBEDDING_BATCH_PARTIALLY_ACCEPTED" });
  expect(isKnownUnacceptedProviderError(failure)).toBe(false);
  expect(checks).toBe(2);
  expect(embeds).toBe(1);
});
