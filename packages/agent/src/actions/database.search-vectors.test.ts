/**
 * Covers the DATABASE action's `search_vectors` op: it must embed the text query
 * and pass only the resulting vector (never the raw query) into `searchMemories`.
 * Deterministic — runtime, embedding model, and memory search are vi.fn stubs.
 */
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { databaseAction } from "./database";

function createRuntime() {
  const searchMemories = vi.fn().mockResolvedValue([
    {
      id: "memory-1",
      content: { text: "I bought a new car" },
      roomId: "room-1",
      entityId: "entity-1",
      createdAt: 123,
      similarity: 0.91,
    },
  ]);
  const useModel = vi.fn().mockImplementation((model: unknown) => {
    if (model === ModelType.TEXT_EMBEDDING) return [0.1, 0.2, 0.3];
    throw new Error(`unexpected model ${model}`);
  });

  const runtime = {
    useModel,
    searchMemories,
    registerSearchCategory: vi.fn(),
    adapter: {},
  } as unknown as IAgentRuntime;

  return { runtime, searchMemories, useModel };
}

describe("DATABASE search_vectors", () => {
  it("does not pass the text query into vector memory search", async () => {
    const { runtime, searchMemories, useModel } = createRuntime();

    const result = (await databaseAction.handler(
      runtime,
      {} as Memory,
      undefined,
      {
        parameters: {
          action: "search_vectors",
          query: "automobile purchase",
          table: "memories",
          limit: 7,
          threshold: 0.4,
        },
      },
    )) as ActionResult;

    expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING, {
      text: "automobile purchase",
    });
    expect(searchMemories).toHaveBeenCalledWith({
      embedding: [0.1, 0.2, 0.3],
      tableName: "memories",
      limit: 7,
      match_threshold: 0.4,
    });
    expect(searchMemories.mock.calls[0]?.[0]).not.toHaveProperty("query");
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "search_vectors",
      query: "automobile purchase",
      table: "memories",
    });
  });
});
