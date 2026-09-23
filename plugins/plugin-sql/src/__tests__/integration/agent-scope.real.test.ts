/** Verifies lifecycle agent scopes against real PGlite ownership and transaction rollback. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabaseAdapter, plugin } from "../../index";

const id = () => randomUUID() as UUID;

let directory: string | undefined;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let testAgentId: UUID;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-scope-"));
  testAgentId = id();
  adapter = createDatabaseAdapter({ dataDir: directory }, testAgentId);
  await adapter.initialize();
  if (!adapter.runPluginMigrations) throw new Error("SQL migrations unavailable");
  await adapter.runPluginMigrations([plugin]);
  await adapter.createAgents([
    { id: testAgentId, name: "Host", createdAt: Date.now(), updatedAt: Date.now() },
  ]);
}, 120000);

afterEach(async () => {
  try {
    if (adapter) await adapter.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
}, 120000);

test("target scope owns every graph row and leaves the importing adapter unchanged", async () => {
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
}, 60000);

test("a failed scoped restore rolls back the new agent and its graph", async () => {
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
}, 60000);

test("agent scope cannot replace an inherited entity transaction context", async () => {
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
}, 60000);
