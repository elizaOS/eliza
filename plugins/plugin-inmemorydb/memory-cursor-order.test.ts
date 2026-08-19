/**
 * Exercises the real ephemeral adapter's memory keyset order, including UUID
 * hexadecimal case that PostgreSQL normalizes before comparing.
 */

import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const agentId = "10000000-0000-4000-8000-000000000001" as UUID;
const entityId = "20000000-0000-4000-8000-000000000001" as UUID;
const roomId = "30000000-0000-4000-8000-000000000001" as UUID;

describe("memory keyset ordering", () => {
  it("does not skip or repeat mixed-case UUIDs at a cursor boundary", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
    const ids = [
      "A0000000-0000-0000-0000-000000000001",
      "a0000000-0000-0000-0000-000000000002",
      "A0000000-0000-0000-0000-000000000003",
      "a0000000-0000-0000-0000-000000000004",
    ] as UUID[];
    const memories: Memory[] = ids.map((id, index) => ({
      id,
      agentId,
      entityId,
      roomId,
      createdAt: 1_000,
      content: { text: `case ${index}` },
    }));
    await adapter.createMemories(memories.map((memory) => ({ memory, tableName: "messages" })));

    const first = await adapter.getMemories({
      roomId,
      tableName: "messages",
      limit: 2,
    });
    expect(first.map((memory) => memory.id)).toEqual([ids[3], ids[2]]);

    const second = await adapter.getMemories({
      roomId,
      tableName: "messages",
      limit: 2,
      cursor: { createdAt: 1_000, id: ids[2] },
    });
    expect(second.map((memory) => memory.id)).toEqual([ids[1], ids[0]]);
  });
});
