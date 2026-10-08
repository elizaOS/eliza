/**
 * A current fact taken from an extraction message must not be dated at the
 * Unix epoch when that message has no createdAt.
 */
import type {
  EvaluatorProcessorContext,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { factMemoryEvaluator } from "./reflection-items";

const agentId = "00000000-0000-4000-8000-0000000000a1" as UUID;
const entityId = "00000000-0000-4000-8000-0000000000b1" as UUID;
const roomId = "00000000-0000-4000-8000-0000000000c1" as UUID;
const sourceId = "00000000-0000-4000-8000-0000000000d1" as UUID;

function runtime() {
  const createdId = "00000000-0000-4000-8000-0000000000e1" as UUID;
  let createdMemory: Memory | null = null;
  return {
    agentId,
    createMemory: vi.fn(async (memoryArg: Memory) => {
      createdMemory = { ...memoryArg, id: createdId };
      return createdId;
    }),
    getMemoryById: vi.fn(async () => createdMemory),
    updateMemory: vi.fn(async () => undefined),
    deleteMemory: vi.fn(async () => undefined),
    useModel: vi.fn(async () => {
      throw new Error("fact evaluator must not request embeddings");
    }),
    queueEmbeddingGeneration: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime & {
    createMemory: ReturnType<typeof vi.fn>;
  };
}

function sourceMessage(createdAt?: number): Memory {
  return {
    id: sourceId,
    entityId,
    agentId,
    roomId,
    content: { text: "I am in Berlin this week" },
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

async function addCurrentFact(message: Memory) {
  const processor = factMemoryEvaluator.processors?.[0];
  if (!processor) throw new Error("missing fact processor");
  const stub = runtime();
  await processor.process({
    runtime: stub,
    message,
    state: { values: {}, data: {}, text: "" },
    options: {
      extraction: {
        isBackfill: false,
        messages: [message],
        sourceRevisions: { [sourceId]: "rev-1" },
        changedMessageIds: [],
        removedMessageIds: [],
        evidenceId: "evidence-1",
        referenceRevisions: {},
      },
    },
    evaluatorName: "factMemory",
    prepared: {
      recentMessages: [],
      existingRelationships: [],
      entities: [],
      knownFacts: [],
    },
    output: {
      ops: [
        {
          op: "add_current",
          claim: "The user is in Berlin this week",
          category: "uncategorized",
          structured_fields: {},
          keywords: ["berlin"],
          sourceMessageIds: [sourceId],
        },
      ],
    },
  } as EvaluatorProcessorContext);
  const saved = stub.createMemory.mock.calls[0]?.[0] as Memory | undefined;
  return (saved?.metadata as { validAt?: string } | undefined)?.validAt;
}

describe("current fact validAt without createdAt", () => {
  it("uses the current time when the extraction message has no createdAt", async () => {
    const before = Date.now();
    const validAt = await addCurrentFact(sourceMessage());
    const after = Date.now();
    expect(validAt).toBeTruthy();
    const parsed = Date.parse(validAt ?? "");
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("keeps a createdAt that the extraction message already has", async () => {
    const createdAt = Date.parse("2024-06-15T12:00:00.000Z");
    const validAt = await addCurrentFact(sourceMessage(createdAt));
    expect(validAt).toBe("2024-06-15T12:00:00.000Z");
  });
});
