/**
 * Pins getMemories query parity with plugin-sql for entityId isolation:
 * entityId establishes the caller's RLS principal and must not remove other
 * participants' turns from the same bounded room/agent transcript.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("getMemories entity isolation parity", () => {
  const agentId = randomUUID() as UUID;
  const adminId = randomUUID() as UUID;
  const otherId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await storage.init();
    adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
  });

  it("returns the newest bounded room transcript across participants", async () => {
    const participants = [adminId, agentId, otherId] as const;
    const memories: Memory[] = Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID() as UUID,
      agentId,
      entityId: participants[index % participants.length],
      roomId,
      createdAt: index + 1,
      content: { text: `turn ${index + 1}` },
    }));
    await adapter.createMemories(memories.map((memory) => ({ memory, tableName: "memories" })));

    const result = await adapter.getMemories({
      agentId,
      entityId: adminId,
      roomId,
      limit: 15,
      orderBy: "createdAt",
      orderDirection: "desc",
      unique: false,
      tableName: "memories",
    });

    expect(result.map((memory) => memory.content.text)).toEqual(
      Array.from({ length: 15 }, (_, index) => `turn ${20 - index}`)
    );
    expect(new Set(result.map((memory) => memory.entityId))).toEqual(
      new Set([adminId, agentId, otherId])
    );
  });
});
