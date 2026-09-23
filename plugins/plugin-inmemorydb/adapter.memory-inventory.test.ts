/** Checks complete memory-type discovery on shared ephemeral storage without crossing agents. */
import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { expect, test } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const id = () => randomUUID() as UUID;

test("discovers unknown namespaces only for the owning agent", async () => {
  const storage = new MemoryStorage();
  const owner = id(),
    foreign = id();
  const adapter = new InMemoryDatabaseAdapter(storage, owner);
  const other = new InMemoryDatabaseAdapter(storage, foreign);
  await adapter.initialize();
  await other.initialize();
  try {
    const row = (agentId: UUID) => ({
      id: id(),
      agentId,
      entityId: id(),
      roomId: id(),
      content: { text: "Inventory fixture" },
    });
    await adapter.createMemories([
      { memory: row(owner), tableName: "messages" },
      { memory: row(owner), tableName: "plugin_unlisted" },
    ]);
    await other.createMemories([{ memory: row(foreign), tableName: "foreign_only" }]);
    expect(await adapter.listMemoryTypes()).toEqual(["messages", "plugin_unlisted"]);
    expect(await other.listMemoryTypes()).toEqual(["foreign_only"]);
    await adapter.createMemories([{ memory: row(owner), tableName: "" }]);
    await expect(adapter.listMemoryTypes()).rejects.toMatchObject({
      code: "MEMORY_STORAGE_TYPE_INVALID",
      message: "Cannot inventory memories with a missing storage type",
      context: { agentId: owner },
    });
  } finally {
    await other.close();
    await adapter.close();
  }
});
