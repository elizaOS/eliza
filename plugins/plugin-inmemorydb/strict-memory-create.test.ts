/**
 * Real MemoryStorage coverage for strict memory creation. The ephemeral
 * adapter has no rollback primitive, so it must reject the atomic SQL-only
 * contract before writing any row rather than expose partial-import success.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("InMemoryDatabaseAdapter strict memory creation", () => {
  it("fails before writing any requested row", async () => {
    const agentId = randomUUID() as UUID;
    const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.initialize();
    const memories = [0, 1].map(
      (index): Memory => ({
        id: randomUUID() as UUID,
        agentId,
        entityId: randomUUID() as UUID,
        roomId: randomUUID() as UUID,
        content: { text: `memory ${index}` },
      })
    );

    await expect(
      adapter.createMemories(
        memories.map((memory) => ({ memory, tableName: "messages" })),
        { onIdConflict: "error" }
      )
    ).rejects.toThrow(/unavailable for the non-transactional/);
    await expect(
      adapter.getMemoriesByIds(memories.map((memory) => memory.id as UUID))
    ).resolves.toEqual([]);
  });
});
