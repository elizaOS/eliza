/** Exercises the real BGE tokenizer and Workers AI transport with deterministic HTTP responses. */
import { afterEach, expect, test } from "bun:test";
import { embedMany } from "ai";
import { isKnownUnacceptedProviderError } from "../services/inference-provider-outcome";
import {
  createCloudflareBindingEmbeddingModel,
  createCloudflareEmbeddingModel,
} from "./cloudflare-embeddings";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const model = () => createCloudflareEmbeddingModel("a".repeat(32), "test-token");

test("sends complete ordered inputs with CLS and normalizes returned vectors", async () => {
  const values = ["Meeting notes including the final action item.", "A different complete source."];
  let captured: unknown;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return Response.json({
      success: true,
      result: {
        data: [
          [3, 4, ...Array(382).fill(0)],
          [4, 3, ...Array(382).fill(0)],
        ],
      },
    });
  };
  const result = await embedMany({ model: model(), values, maxRetries: 0 });
  expect(captured).toEqual({ text: values, pooling: "cls" });
  expect(result.embeddings[0]?.[0]).toBeCloseTo(0.6);
  expect(result.embeddings[1]?.[0]).toBeCloseTo(0.8);
});

test("rejects the entire batch before sending a valid prefix when any input is oversized", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("must not dispatch");
  };
  await expect(
    embedMany({
      model: model(),
      values: [
        ...Array(101).fill("Short source"),
        "A meeting about database backups. ".repeat(200),
      ],
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
  expect(requests).toBe(0);
});

test.each([
  { success: false, result: { data: [] } },
  { success: true, result: { data: [] } },
  { success: true, result: { data: [[1, 2]] } },
  { success: true, result: { data: [Array(384).fill(0)] } },
])("rejects unusable upstream responses instead of returning partial vectors", async (body) => {
  globalThis.fetch = async () => Response.json(body);
  await expect(
    embedMany({ model: model(), values: ["Source text"], maxRetries: 0 }),
  ).rejects.toThrow();
});

test("forwards cancellation to the HTTP transport", async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    controller.abort(new Error("request cancelled"));
    init?.signal?.throwIfAborted();
    throw new Error("cancellation was not forwarded");
  };
  await expect(
    embedMany({
      model: model(),
      values: ["Complete source"],
      abortSignal: controller.signal,
      maxRetries: 0,
    }),
  ).rejects.toThrow("request cancelled");
});

test("reassembles provider-sized batches in source order", async () => {
  const values = Array.from({ length: 205 }, (_, i) => `Source ${i}`);
  const received: string[] = [];
  const sizes: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { text: string[] };
    sizes.push(request.text.length);
    received.push(...request.text);
    return Response.json({
      success: true,
      result: {
        data: request.text.map((text) => {
          const value = Number(text.split(" ")[1]);
          return [value, 1, ...Array(382).fill(0)];
        }),
      },
    });
  };
  const result = await embedMany({ model: model(), values, maxRetries: 0 });
  expect(received).toEqual(values);
  expect(sizes).toEqual([100, 100, 5]);
  expect(result.embeddings.map((vector) => Math.round(vector[0] / vector[1]))).toEqual(
    values.map((_, i) => i),
  );
});

test("an explicit first-request rejection releases the billing hold", async () => {
  globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
  let error: unknown;
  try {
    await embedMany({ model: model(), values: ["Source"], maxRetries: 0 });
  } catch (caught) {
    error = caught;
  }
  expect(isKnownUnacceptedProviderError(error)).toBe(true);
});

test("a later batch rejection does not erase accepted work or replay its prefix", async () => {
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    if (requests > 1) return new Response("Rate limited", { status: 429 });
    const request = JSON.parse(String(init?.body)) as { text: string[] };
    return Response.json({
      success: true,
      result: { data: request.text.map(() => [1, ...Array(383).fill(0)]) },
    });
  };
  let error: unknown;
  try {
    await embedMany({ model: model(), values: Array(101).fill("Source"), maxRetries: 2 });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "EMBEDDING_BATCH_PARTIALLY_ACCEPTED" });
  expect(isKnownUnacceptedProviderError(error)).toBe(false);
  expect(requests).toBe(2);
});

test("native binding preserves full ordered batches and rejects oversized inputs before dispatch", async () => {
  const received: string[] = [];
  const binding = createCloudflareBindingEmbeddingModel({
    async run(_model, input) {
      expect(input.pooling).toBe("cls");
      received.push(...input.text);
      return {
        data: input.text.map((text) => [Number(text.split(" ")[1]), 1, ...Array(382).fill(0)]),
      };
    },
  });
  const values = Array.from({ length: 205 }, (_, i) => `Source ${i}`);
  const result = await embedMany({ model: binding, values, maxRetries: 0 });
  expect(received).toEqual(values);
  expect(result.embeddings.map((vector) => Math.round(vector[0] / vector[1]))).toEqual(
    values.map((_, i) => i),
  );
  received.length = 0;
  await expect(
    embedMany({
      model: binding,
      values: ["Source 1", "A meeting about database backups. ".repeat(200)],
      maxRetries: 0,
    }),
  ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
  expect(received).toEqual([]);
});

test("native binding cancellation stops later batches without replaying accepted work", async () => {
  const controller = new AbortController();
  let calls = 0;
  const binding = createCloudflareBindingEmbeddingModel({
    async run(_model, input) {
      calls++;
      controller.abort(new Error("cancelled after acceptance"));
      return { data: input.text.map(() => [1, ...Array(383).fill(0)]) };
    },
  });
  await expect(
    embedMany({
      model: binding,
      values: Array(101).fill("Source"),
      abortSignal: controller.signal,
      maxRetries: 2,
    }),
  ).rejects.toMatchObject({ code: "EMBEDDING_BATCH_PARTIALLY_ACCEPTED" });
  expect(calls).toBe(1);
});

test.each([
  undefined,
  { data: [[1, 2]] },
  { data: [Array(384).fill(0)] },
  { data: [Array(384).fill(Number.NaN)] },
])("native binding rejects invalid responses at the real adapter boundary", async (body) => {
  await expect(
    embedMany({
      model: createCloudflareBindingEmbeddingModel({
        async run() {
          return body;
        },
      }),
      values: ["Source"],
      maxRetries: 0,
    }),
  ).rejects.toThrow();
});
