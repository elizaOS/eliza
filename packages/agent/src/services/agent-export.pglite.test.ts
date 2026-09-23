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
  const password = "fixture-transfer-password";
  const archive = await exportAgent(source.runtime, password);
  const result = await importAgent(target.runtime, archive, password);
  expect(result.agentId).not.toBe(target.agentId);
  expect(result.counts).toMatchObject({
    worlds: 1,
    rooms: 1,
    entities: 1,
    memories: 1,
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
      const entities = await scoped.getEntitiesByIds([memories[0].entityId]);
      expect(entities[0].agentId).toBe(result.agentId);
    },
  );
  expect(await target.adapter.getAllWorlds()).toEqual([]);
}, 60000);
