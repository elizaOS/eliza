import {
  buildMessageContentProjection,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

const agentId = "71000000-0000-4000-8000-000000000001" as UUID;
const roomId = "71000000-0000-4000-8000-000000000002" as UUID;
const entityId = "71000000-0000-4000-8000-000000000003" as UUID;
const id = "71000000-0000-4000-8000-000000000004" as UUID;
function publication(dimension: number) {
  const parent: Memory & { id: UUID } = {
    id,
    agentId,
    roomId,
    entityId,
    content: { text: "semantic content ".repeat(10000) },
    metadata: { type: "message", scope: "room" },
  };
  const projection = buildMessageContentProjection(parent);
  const embedding = Array.from({ length: dimension }, (_, index) =>
    index === 0 ? 1 : 0,
  );
  return {
    mode: "create" as const,
    parent: { ...parent, content: projection.content },
    segments: projection.segments.map((segment) => {
      if (!segment.id) throw new Error("Expected projected segment ID");
      return { ...segment, id: segment.id, embedding };
    }),
  };
}
test("published segment embeddings are searchable immediately", async () => {
  const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
  try {
    await adapter.initialize();
    const input = publication(384);
    await adapter.publishMessageContentSegments(input);
    const found = await adapter.searchMemories({
      tableName: "message_content_segments",
      roomId,
      embedding: input.segments[0].embedding,
    });
    expect(found.map((memory) => memory.id).sort()).toEqual(
      input.segments.map((segment) => segment.id).sort(),
    );
  } finally {
    await adapter.close();
  }
});
test("index failure does not publish parent or segments", async () => {
  const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
  try {
    await adapter.initialize();
    const input = publication(3);
    await expect(
      adapter.publishMessageContentSegments(input),
    ).rejects.toThrow();
    expect(
      await adapter.getMemoriesByIds([
        id,
        ...input.segments.map((segment) => segment.id),
      ]),
    ).toEqual([]);
  } finally {
    await adapter.close();
  }
});
