/** Exercises encrypted transfer export and import against two real isolated PGlite stores. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, ChannelType, type UUID } from "@elizaos/core";
import { createDatabaseAdapter, plugin } from "@elizaos/plugin-sql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { exportAgent, importAgent } from "./agent-export";

const id = () => randomUUID() as UUID;

let directory: string | undefined;
const originalState = process.env.ELIZA_STATE_DIR;
const ownedAdapters: ReturnType<typeof createDatabaseAdapter>[] = [];
function requireDirectory(): string {
  if (!directory) throw new Error("Transfer fixture directory is unavailable");
  return directory;
}
const create = async (label: string) => {
  const agentId = id();
  const adapter = createDatabaseAdapter(
    { dataDir: join(requireDirectory(), label) },
    agentId,
  );
  ownedAdapters.push(adapter);
  await adapter.initialize();
  if (!adapter.runPluginMigrations)
    throw new Error("SQL migrations unavailable");
  await adapter.runPluginMigrations([plugin]);
  await adapter.createAgents([
    {
      id: agentId,
      name: label,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
  return {
    adapter,
    agentId,
    runtime: new AgentRuntime({
      agentId,
      adapter,
      character: { name: label },
      plugins: [],
    }),
  };
};
let source: Awaited<ReturnType<typeof create>>;
let target: Awaited<ReturnType<typeof create>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-transfer-sql-"));
  process.env.ELIZA_STATE_DIR = join(directory, "state");
  source = await create("source");
  target = await create("target");
}, 120000);

afterAll(async () => {
  if (originalState === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = originalState;
  try {
    const results = await Promise.allSettled(
      ownedAdapters.map((adapter) => adapter.close()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Transfer fixture cleanup failed",
      );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("restores timestamp-bearing SQL rows under the imported agent and retains memory history", async () => {
  const world = id(),
    room = id(),
    person = id();
  await source.adapter.createWorlds([
    { id: world, agentId: source.agentId, name: "Retained world" },
  ]);
  await source.adapter.createRooms([
    {
      id: room,
      agentId: source.agentId,
      worldId: world,
      source: "test",
      type: ChannelType.GROUP,
    },
  ]);
  await source.adapter.createEntities([
    { id: person, agentId: source.agentId, names: ["Retained owner"] },
  ]);
  await source.adapter.createRoomParticipants([person], room);
  const createdAt = 1_700_000_000_000;
  const content = {
    text: "The complete retained memory, including its ending.",
  };
  await source.adapter.createMemories([
    {
      memory: {
        id: id(),
        agentId: source.agentId,
        roomId: room,
        entityId: person,
        createdAt,
        content,
      },
      tableName: "messages",
    },
  ]);
  const documentId = id();
  const common = {
    agentId: source.agentId,
    roomId: room,
    entityId: person,
    createdAt,
  };
  await source.adapter.createMemories([
    {
      tableName: "documents",
      memory: {
        ...common,
        id: documentId,
        content: { text: "Full retained document" },
        metadata: { type: "document", timestamp: createdAt },
      },
    },
    {
      tableName: "document_fragments",
      memory: {
        ...common,
        id: id(),
        content: { text: "Retained document fragment" },
        metadata: { type: "fragment", documentId, position: 0 },
      },
    },
    {
      tableName: "document_fragments",
      memory: {
        ...common,
        id: id(),
        content: { text: "Physical fragment without a semantic discriminator" },
        metadata: {
          documentId,
          position: 1,
          custom: { retained: "complete metadata" },
        },
      },
    },
    {
      tableName: "memories",
      memory: {
        ...common,
        id: id(),
        content: { text: "Generic retained memory" },
      },
    },
    {
      tableName: "plugin_fixture_notes",
      memory: {
        ...common,
        id: id(),
        content: { text: "Plugin-owned memory" },
        metadata: { type: "message" },
      },
    },
  ]);
  if (!source.adapter.withAgentScope || !source.adapter.listMemoryTypes)
    throw new Error("SQL export capabilities unavailable");
  const foreign = id();
  await source.adapter.withAgentScope(foreign, async (scoped) => {
    await scoped.createAgents([
      {
        id: foreign,
        name: "Foreign fixture",
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    const foreignRoom = id(),
      foreignEntity = id();
    await scoped.createRooms([
      {
        id: foreignRoom,
        agentId: foreign,
        source: "test",
        type: ChannelType.GROUP,
      },
    ]);
    await scoped.createEntities([
      { id: foreignEntity, agentId: foreign, names: ["Foreign"] },
    ]);
    await scoped.createMemories([
      {
        tableName: "foreign_only",
        memory: {
          id: id(),
          agentId: foreign,
          entityId: foreignEntity,
          roomId: foreignRoom,
          content: { text: "Must not be exported" },
        },
      },
    ]);
  });
  const originalTypes = await source.adapter.listMemoryTypes();
  expect(originalTypes).not.toContain("foreign_only");
  const password = "fixture-transfer-password";
  const archive = await exportAgent(source.runtime, password);
  const result = await importAgent(target.runtime, archive, password);
  expect(result.agentId).not.toBe(target.agentId);
  expect(result.counts).toMatchObject({
    worlds: 1,
    rooms: 1,
    entities: 1,
    memories: 6,
  });
  if (!target.adapter.withAgentScope) throw new Error("SQL scope unavailable");
  await target.adapter.withAgentScope(
    result.agentId as UUID,
    async (scoped) => {
      const worlds = await scoped.getAllWorlds();
      expect(worlds).toHaveLength(1);
      expect(worlds[0].agentId).toBe(result.agentId);
      const rooms = await scoped.getRoomsByWorlds(
        worlds.map((item) => item.id),
      );
      expect(rooms).toHaveLength(1);
      expect(rooms[0].agentId).toBe(result.agentId);
      const memories = await scoped.getMemories({
        agentId: result.agentId as UUID,
        tableName: "messages",
      });
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toEqual(content);
      expect(memories[0].createdAt).toBe(createdAt);
      expect(memories[0].roomId).toBe(rooms[0].id);
      if (!scoped.listMemoryTypes)
        throw new Error("SQL memory inventory unavailable");
      expect(await scoped.listMemoryTypes()).toEqual(originalTypes);
      const documents = await scoped.getMemories({ tableName: "documents" });
      const fragments = await scoped.getMemories({
        tableName: "document_fragments",
      });
      expect(documents).toHaveLength(1);
      expect(fragments).toHaveLength(2);
      expect(
        fragments.find((fragment) => fragment.metadata?.type === "fragment")
          ?.metadata,
      ).toMatchObject({
        documentId: documents[0].id,
        position: 0,
      });
      expect(
        fragments.find((fragment) => fragment.metadata?.type !== "fragment")
          ?.metadata,
      ).toEqual({
        documentId: documents[0].id,
        position: 1,
        custom: { retained: "complete metadata" },
      });
      expect(
        (await scoped.getMemories({ tableName: "plugin_fixture_notes" }))[0]
          .metadata?.type,
      ).toBe("message");
      expect(await scoped.getMemories({ tableName: "foreign_only" })).toEqual(
        [],
      );
      const entities = await scoped.getEntitiesByIds([memories[0].entityId]);
      expect(entities[0].agentId).toBe(result.agentId);
    },
  );
  expect(await target.adapter.getAllWorlds()).toEqual([]);
}, 60000);
