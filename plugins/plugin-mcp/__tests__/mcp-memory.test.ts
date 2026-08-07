/**
 * MCP audit-memory persistence tests cover runtimes with and without an
 * embedding model so keyless tool and resource execution remains usable.
 */
import { type IAgentRuntime, type Memory, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createMcpMemory } from "../src/utils/mcp";

const message = {
  entityId: "entity-1",
  roomId: "room-1",
  content: { text: "read the resource" },
} as unknown as Memory;

function createRuntime(embeddingModelRegistered: boolean) {
  const addEmbeddingToMemory = vi.fn(async (memory: Memory) => ({
    ...memory,
    embedding: [0.25, 0.75],
  }));
  const createMemory = vi.fn(async () => undefined);
  const getModel = vi.fn((modelType: ModelType) =>
    embeddingModelRegistered && modelType === ModelType.TEXT_EMBEDDING ? vi.fn() : undefined
  );
  const runtime = {
    agentId: "agent-1",
    addEmbeddingToMemory,
    createMemory,
    getModel,
  } as unknown as IAgentRuntime;

  return { runtime, addEmbeddingToMemory, createMemory, getModel };
}

describe("createMcpMemory", () => {
  it("persists resource audit memory without a vector when embeddings are unavailable", async () => {
    const { runtime, addEmbeddingToMemory, createMemory, getModel } = createRuntime(false);

    await createMcpMemory(runtime, message, "resource", "fixture", "payload", {
      uri: "fixture://note",
    });

    expect(getModel).toHaveBeenCalledWith(ModelType.TEXT_EMBEDDING);
    expect(addEmbeddingToMemory).not.toHaveBeenCalled();
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "entity-1",
        agentId: "agent-1",
        roomId: "room-1",
        content: expect.objectContaining({
          metadata: { uri: "fixture://note", serverName: "fixture" },
        }),
      }),
      "resources",
      true
    );
  });

  it("embeds tool audit memory when the runtime provides an embedding model", async () => {
    const { runtime, addEmbeddingToMemory, createMemory } = createRuntime(true);

    await createMcpMemory(runtime, message, "tool", "fixture", "payload", {
      toolName: "echo",
    });

    expect(addEmbeddingToMemory).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: [0.25, 0.75] }),
      "tools",
      true
    );
  });
});
