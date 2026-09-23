/** Verifies lifecycle agent scopes against real PGlite ownership and transaction rollback. */
import { randomUUID } from "node:crypto";
import { ChannelType, type UUID } from "@elizaos/core";
import { expect, test } from "vitest";
import { createIsolatedTestDatabase } from "../test-helpers";

const id = () => randomUUID() as UUID;

test("target scope owns every graph row and leaves the importing adapter unchanged", async () => {
  const { adapter, cleanup, testAgentId } = await createIsolatedTestDatabase("agent-scope", [], {
    postgresUrl: null,
  });
  try {
    const target = id(),
      world = id(),
      room = id(),
      entity = id(),
      hostWorld = id();
    await adapter.withAgentScope(target, async (scoped) => {
      await scoped.createAgents([
        { id: target, name: "Imported", createdAt: Date.now(), updatedAt: Date.now() },
      ]);
      await scoped.createWorlds([{ id: world, agentId: target, name: "Imported world" }]);
      await scoped.createRooms([
        { id: room, agentId: target, worldId: world, source: "test", type: ChannelType.GROUP },
      ]);
      await scoped.createEntities([{ id: entity, agentId: target, names: ["Imported entity"] }]);
    });
    expect((await adapter.getWorld(world))?.agentId).toBe(target);
    await adapter.withAgentScope(target, async (scoped) => {
      expect((await scoped.getRoomsByIds([room]))[0]?.agentId).toBe(target);
      expect((await scoped.getEntitiesByIds([entity]))[0]?.agentId).toBe(target);
    });
    expect(await adapter.getRoomsByIds([room])).toEqual([]);
    await adapter.createWorlds([{ id: hostWorld, agentId: testAgentId, name: "Host world" }]);
    expect((await adapter.getWorld(hostWorld))?.agentId).toBe(testAgentId);
  } finally {
    await cleanup();
  }
}, 60000);

test("a failed scoped restore rolls back the new agent and its graph", async () => {
  const { adapter, cleanup, testAgentId } = await createIsolatedTestDatabase(
    "agent-scope-rollback",
    [],
    { postgresUrl: null }
  );
  try {
    const target = id(),
      world = id();
    await expect(
      adapter.withAgentScope(target, async (scoped) => {
        await scoped.createAgents([
          { id: target, name: "Incomplete", createdAt: Date.now(), updatedAt: Date.now() },
        ]);
        await scoped.createWorlds([{ id: world, agentId: target, name: "Incomplete world" }]);
        throw new Error("restore interrupted");
      })
    ).rejects.toThrow("restore interrupted");
    expect(await adapter.getAgent(target)).toBeNull();
    expect(await adapter.getWorld(world)).toBeNull();
    expect(await adapter.getAgent(testAgentId)).not.toBeNull();
  } finally {
    await cleanup();
  }
}, 60000);

test("agent scope cannot replace an inherited entity transaction context", async () => {
  const { adapter, cleanup } = await createIsolatedTestDatabase("agent-scope-authority", [], {
    postgresUrl: null,
  });
  try {
    const owner = id(),
      other = id();
    await expect(
      adapter.transaction(
        async (tx) => {
          if (!tx.withAgentScope) throw new Error("SQL agent scope unavailable");
          return tx.withAgentScope(id(), (scoped) =>
            scoped.transaction(async () => true, { entityContext: other })
          );
        },
        { entityContext: owner }
      )
    ).rejects.toMatchObject({ code: "TRANSACTION_ENTITY_CONTEXT_MISMATCH" });
  } finally {
    await cleanup();
  }
}, 60000);
