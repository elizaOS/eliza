/**
 * Drives the first-party in-memory adapter through stable vector keyset pages
 * so an ignored cursor cannot masquerade as complete retrieval.
 */

import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "50000000-0000-4000-8000-000000000001" as UUID;
const ROOM_ID = "50000000-0000-4000-8000-000000000002" as UUID;

describe("issue #25150 in-memory stable search cursor", () => {
  it("returns the next vector page instead of repeating the first page", async () => {
    const storage = new MemoryStorage();
    const adapter = new InMemoryDatabaseAdapter(storage, AGENT_ID);
    await adapter.initialize();
    const embedding = (tilt: number): number[] => {
      const vector = Array.from({ length: 384 }, () => 0);
      vector[0] = 1;
      vector[1] = tilt;
      return vector;
    };
    const memories: Memory[] = Array.from({ length: 5 }, (_, index) => ({
      id: `50000000-0000-4000-8000-00000000000${index + 3}` as UUID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      createdAt: 100 - index,
      content: { text: `memory ${index}` },
      embedding:
        index >= 3
          ? Array.from({ length: 384 }, (_, dimension) => {
              if (dimension === 0 && index === 4) return -1;
              if (dimension === 1 && index === 3) return 1;
              return 0;
            })
          : embedding(index / 10),
    }));
    await adapter.createMemories(memories.map((memory) => ({ memory, tableName: "messages" })));

    const first = await adapter.searchMemoriesPage({
      tableName: "messages",
      embedding: embedding(0),
      limit: 1,
    });
    const firstRow = first.items[0];
    expect(firstRow).toBeDefined();
    const second = await adapter.searchMemoriesPage({
      tableName: "messages",
      embedding: embedding(0),
      limit: 1,
      cursor: first.nextCursor,
    });

    expect(second.items[0]?.id).toBe(memories[1]?.id);
    const seen = [...first.items, ...second.items];
    let cursor = second.nextCursor;
    while (cursor) {
      const page = await adapter.searchMemoriesPage({
        tableName: "messages",
        embedding: embedding(0),
        limit: 1,
        cursor,
      });
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen.map((memory) => memory.id)).toEqual(memories.map((memory) => memory.id));
    const zeroThreshold = await adapter.searchMemoriesPage({
      tableName: "messages",
      embedding: embedding(0),
      match_threshold: 0,
      limit: 10,
    });
    expect(zeroThreshold.items.map((memory) => memory.id)).toEqual(
      memories.slice(0, 4).map((memory) => memory.id)
    );
  });
});
