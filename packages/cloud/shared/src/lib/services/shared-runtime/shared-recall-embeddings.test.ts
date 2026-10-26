import { describe, expect, test } from "bun:test";
import { BGE_SMALL_VECTOR_SPACE, getEmbeddingVectorSpace } from "@elizaos/core";
import { runWithCloudBindings } from "../../runtime/cloud-bindings";
import { embedSharedRecallTexts, sharedRecallEnabled } from "./shared-recall-embeddings";

const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));

describe("Shared recall through Workers AI", () => {
  test("recall stays enabled without a sidecar and request bindings remain isolated", async () => {
    expect(runWithCloudBindings({ SHARED_RECALL_ENABLED: "true" }, sharedRecallEnabled)).toBe(true);
    expect(runWithCloudBindings({ SHARED_RECALL_ENABLED: "false" }, sharedRecallEnabled)).toBe(
      false,
    );
    const calls: unknown[] = [];
    const result = await runWithCloudBindings(
      {
        SHARED_RECALL_ENABLED: "true",
        LOCAL_EMBEDDINGS_BASE_URL: "https://retired-sidecar.invalid",
        ELIZA_EMBEDDINGS_FORCE_LOCAL: "false",
        AI: {
          run: async (model: unknown, input: { text: string[] }) => {
            calls.push({ model, input });
            return { data: input.text.map(() => vector) };
          },
        },
      },
      () => embedSharedRecallTexts(["First memory", "Second memory"]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "@cf/baai/bge-small-en-v1.5",
      input: { pooling: "cls", text: ["First memory", "Second memory"] },
    });
    expect(result).toHaveLength(2);
    for (const embedding of result) {
      expect(embedding).toHaveLength(384);
      expect(Math.hypot(...embedding)).toBeCloseTo(1, 10);
      expect(getEmbeddingVectorSpace(embedding)).toBe(BGE_SMALL_VECTOR_SPACE);
    }
  });

  test("one failing provider call is surfaced without retry or sidecar fallback", async () => {
    let calls = 0;
    const failure = new Error("Provider unavailable");
    await expect(
      runWithCloudBindings(
        {
          AI: {
            run: async () => {
              calls++;
              throw failure;
            },
          },
          LOCAL_EMBEDDINGS_BASE_URL: "https://retired-sidecar.invalid",
          ELIZA_EMBEDDINGS_FORCE_LOCAL: "false",
        },
        () => embedSharedRecallTexts(["A memory"]),
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test("invalid vectors and blank batches cannot become stored canonical vectors", async () => {
    let calls = 0;
    const bindings = {
      ELIZA_EMBEDDINGS_FORCE_LOCAL: "false",
      AI: {
        run: async () => {
          calls++;
          return { data: [[1, 2]] };
        },
      },
    };
    await expect(
      runWithCloudBindings(bindings, () => embedSharedRecallTexts(["valid", " "])),
    ).rejects.toMatchObject({ code: "SHARED_RECALL_EMBEDDING_EMPTY_TEXT" });
    expect(calls).toBe(0);
    await expect(
      runWithCloudBindings(bindings, () => embedSharedRecallTexts(["A memory"])),
    ).rejects.toMatchObject({ code: "EMBEDDING_PROVIDER_RESPONSE_INVALID" });
    expect(calls).toBe(1);
  });
});
