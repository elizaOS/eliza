/** Verifies component reads/writes are scoped to the adapter's agent on real PGlite. */
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
let hostAgentId: UUID;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "component-scope-"));
  hostAgentId = id();
  adapter = createDatabaseAdapter({ dataDir: directory }, hostAgentId);
  await adapter.initialize();
  if (!adapter.runPluginMigrations) throw new Error("SQL migrations unavailable");
  await adapter.runPluginMigrations([plugin]);
  await adapter.createAgents([
    { id: hostAgentId, name: "Host", createdAt: Date.now(), updatedAt: Date.now() },
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

test("another agent's components are invisible and immutable to this adapter", async () => {
  const foreign = id();
  const entity = id();
  const world = id();
  const room = id();
  const componentId = id();

  await adapter.withAgentScope(foreign, async (scoped) => {
    await scoped.createAgents([
      { id: foreign, name: "Foreign", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    await scoped.createWorlds([{ id: world, agentId: foreign, name: "Foreign world" }]);
    await scoped.createRooms([
      { id: room, agentId: foreign, worldId: world, source: "test", type: ChannelType.GROUP },
    ]);
    await scoped.createEntities([{ id: entity, agentId: foreign, names: ["Foreign entity"] }]);
    await scoped.createComponent({
      id: componentId,
      entityId: entity,
      type: "profile",
      data: { text: "foreign secret" },
      worldId: world,
      agentId: foreign,
      roomId: room,
      sourceEntityId: entity,
      createdAt: Date.now(),
    });
  });

  // Reads must not leak.
  expect(await adapter.getComponent(entity, "profile")).toBeNull();
  expect(await adapter.getComponents(entity)).toEqual([]);
  // Writes must not touch the foreign row.
  await adapter.updateComponent({
    id: componentId,
    entityId: entity,
    type: "profile",
    data: { text: "rewritten by host" },
    worldId: world,
    agentId: foreign,
    roomId: room,
    sourceEntityId: entity,
    createdAt: Date.now(),
  });
  await adapter.deleteComponent(componentId);

  // The foreign agent still sees its own component, unchanged.
  await adapter.withAgentScope(foreign, async (scoped) => {
    const own = await scoped.getComponent(entity, "profile");
    expect(own).not.toBeNull();
    expect(own?.data).toEqual({ text: "foreign secret" });
    expect(await scoped.getComponents(entity)).toHaveLength(1);
  });
}, 60000);

test("the adapter can still manage its own components", async () => {
  const entity = id();
  const world = id();
  const room = id();
  const componentId = id();

  await adapter.createWorlds([{ id: world, agentId: hostAgentId, name: "Host world" }]);
  await adapter.createRooms([
    { id: room, agentId: hostAgentId, worldId: world, source: "test", type: ChannelType.GROUP },
  ]);
  await adapter.createEntities([{ id: entity, agentId: hostAgentId, names: ["Host entity"] }]);
  await adapter.createComponent({
    id: componentId,
    entityId: entity,
    type: "profile",
    data: { text: "host data" },
    worldId: world,
    agentId: hostAgentId,
    roomId: room,
    sourceEntityId: entity,
    createdAt: Date.now(),
  });

  expect((await adapter.getComponent(entity, "profile"))?.data).toEqual({ text: "host data" });
  expect(await adapter.getComponents(entity)).toHaveLength(1);
  await adapter.updateComponent({
    id: componentId,
    entityId: entity,
    type: "profile",
    data: { text: "host data v2" },
    worldId: world,
    agentId: hostAgentId,
    roomId: room,
    sourceEntityId: entity,
    createdAt: Date.now(),
  });
  expect((await adapter.getComponent(entity, "profile"))?.data).toEqual({ text: "host data v2" });
  await adapter.deleteComponent(componentId);
  expect(await adapter.getComponents(entity)).toEqual([]);
}, 60000);

test("public batch paths cannot read, delete, or patch another agent's components", async () => {
  const foreign = id();
  const entity = id();
  const world = id();
  const room = id();
  const componentId = id();

  await adapter.withAgentScope(foreign, async (scoped) => {
    await scoped.createAgents([
      { id: foreign, name: "Foreign", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    await scoped.createWorlds([{ id: world, agentId: foreign, name: "Foreign world" }]);
    await scoped.createRooms([
      { id: room, agentId: foreign, worldId: world, source: "test", type: ChannelType.GROUP },
    ]);
    await scoped.createEntities([{ id: entity, agentId: foreign, names: ["Foreign entity"] }]);
    await scoped.createComponent({
      id: componentId,
      entityId: entity,
      type: "profile",
      data: { text: "foreign secret" },
      worldId: world,
      agentId: foreign,
      roomId: room,
      sourceEntityId: entity,
      createdAt: Date.now(),
    });
  });

  // Batch reads must not leak.
  expect(await adapter.getComponentsForEntities([entity])).toEqual([]);
  expect(await adapter.getComponentsByIds([componentId])).toEqual([]);
  // Batch delete and batch patch must not touch the foreign row.
  await adapter.deleteComponents([componentId]);
  await adapter.patchComponents([
    { componentId, ops: [{ op: "set", path: "text", value: "patched by host" }] },
  ]);

  // The foreign agent still sees its own component, unchanged.
  await adapter.withAgentScope(foreign, async (scoped) => {
    const own = await scoped.getComponent(entity, "profile");
    expect(own).not.toBeNull();
    expect(own?.data).toEqual({ text: "foreign secret" });
  });
}, 60000);

test("batch paths still manage the adapter's own components", async () => {
  const entity = id();
  const world = id();
  const room = id();
  const componentId = id();

  await adapter.createWorlds([{ id: world, agentId: hostAgentId, name: "Host world" }]);
  await adapter.createRooms([
    { id: room, agentId: hostAgentId, worldId: world, source: "test", type: ChannelType.GROUP },
  ]);
  await adapter.createEntities([{ id: entity, agentId: hostAgentId, names: ["Host entity"] }]);
  await adapter.createComponents([
    {
      id: componentId,
      entityId: entity,
      type: "profile",
      data: { text: "host data" },
      worldId: world,
      agentId: hostAgentId,
      roomId: room,
      sourceEntityId: entity,
      createdAt: Date.now(),
    },
  ]);

  expect(await adapter.getComponentsForEntities([entity])).toHaveLength(1);
  expect(await adapter.getComponentsByIds([componentId])).toHaveLength(1);
  await adapter.patchComponents([
    { componentId, ops: [{ op: "set", path: "text", value: "host data v2" }] },
  ]);
  expect((await adapter.getComponent(entity, "profile"))?.data).toEqual({ text: "host data v2" });
  await adapter.deleteComponents([componentId]);
  expect(await adapter.getComponentsByIds([componentId])).toEqual([]);
}, 60000);

test("createComponent binds the row to the adapter agent", async () => {
  const foreign = id();
  const entity = id();
  const world = id();
  const room = id();
  const componentId = id();

  await adapter.createAgents([
    { id: foreign, name: "Foreign", createdAt: Date.now(), updatedAt: Date.now() },
  ]);
  await adapter.createWorlds([{ id: world, agentId: hostAgentId, name: "Host world" }]);
  await adapter.createRooms([
    { id: room, agentId: hostAgentId, worldId: world, source: "test", type: ChannelType.GROUP },
  ]);
  await adapter.createEntities([{ id: entity, agentId: hostAgentId, names: ["Host entity"] }]);

  // A caller that supplies another agent's id cannot plant a row in that scope.
  await adapter.createComponent({
    id: componentId,
    entityId: entity,
    type: "profile",
    data: { text: "host data" },
    worldId: world,
    agentId: foreign,
    roomId: room,
    sourceEntityId: entity,
    createdAt: Date.now(),
  });

  const own = await adapter.getComponent(entity, "profile");
  expect(own).not.toBeNull();
  expect(own?.agentId).toBe(hostAgentId);

  // The foreign agent cannot see the planted row.
  await adapter.withAgentScope(foreign, async (scoped) => {
    expect(await scoped.getComponentsByIds([componentId])).toEqual([]);
  });
}, 60000);

test("updateComponent cannot move a row to another agent", async () => {
  const foreign = id();
  const entity = id();
  const world = id();
  const room = id();
  const componentId = id();

  await adapter.createAgents([
    { id: foreign, name: "Foreign", createdAt: Date.now(), updatedAt: Date.now() },
  ]);
  await adapter.createWorlds([{ id: world, agentId: hostAgentId, name: "Host world" }]);
  await adapter.createRooms([
    { id: room, agentId: hostAgentId, worldId: world, source: "test", type: ChannelType.GROUP },
  ]);
  await adapter.createEntities([{ id: entity, agentId: hostAgentId, names: ["Host entity"] }]);
  await adapter.createComponent({
    id: componentId,
    entityId: entity,
    type: "profile",
    data: { text: "host data" },
    worldId: world,
    agentId: hostAgentId,
    roomId: room,
    sourceEntityId: entity,
    createdAt: Date.now(),
  });

  // A caller that rewrites agentId cannot move the row out of this agent's scope.
  await adapter.updateComponent({
    id: componentId,
    entityId: entity,
    type: "profile",
    data: { text: "host data v2" },
    worldId: world,
    agentId: foreign,
    roomId: room,
    sourceEntityId: entity,
    createdAt: Date.now(),
  });

  const own = await adapter.getComponent(entity, "profile");
  expect(own).not.toBeNull();
  expect(own?.agentId).toBe(hostAgentId);
  expect(own?.data).toEqual({ text: "host data v2" });

  await adapter.withAgentScope(foreign, async (scoped) => {
    expect(await scoped.getComponentsByIds([componentId])).toEqual([]);
  });
}, 60000);
