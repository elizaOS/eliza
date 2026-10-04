/**
 * Real-PGlite coverage for per-person graph reads: `getMemories({ entityId })`
 * names the isolation principal, not the author, so a person's facts, fact
 * count and interaction preferences must be selected by author. Two people
 * share a group room and each authors one fact and one preference.
 */
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type UUID,
} from "@elizaos/core";
import type { DrizzleDatabase } from "@elizaos/plugin-sql";
import {
  DatabaseMigrationService,
  PGliteClientManager,
  PgliteDatabaseAdapter,
  schema,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeRelationshipsGraphService,
  getMemoriesForCluster,
} from "./relationships-graph-builder.ts";

async function createRuntime(): Promise<AgentRuntime> {
  const character: Character = {
    name: "Eliza",
    bio: ["Test"],
    templates: {},
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: [],
    knowledge: [],
    secrets: {},
  };
  const runtime = new AgentRuntime({ character, plugins: [sqlPlugin] });
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  const adapter = new PgliteDatabaseAdapter(runtime.agentId, manager);
  await adapter.init();
  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrationService.discoverAndRegisterPluginSchemas([
    { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
  ]);
  await migrationService.runAllPluginMigrations();
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

describe("relationships graph author scope", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  it("shows only a person's own facts and preferences", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const agentId = runtime.agentId;
    const alice = uuidv4() as UUID;
    const bob = uuidv4() as UUID;
    const worldId = uuidv4() as UUID;
    const roomId = uuidv4() as UUID;
    await runtime.createEntities([
      { id: alice, agentId, names: ["alice"], metadata: {} },
      { id: bob, agentId, names: ["bob"], metadata: {} },
    ]);
    await runtime.createWorld({
      id: worldId,
      name: "World",
      agentId,
      messageServerId: worldId,
    });
    await runtime.createRooms([
      {
        id: roomId,
        name: "Group",
        agentId,
        worldId,
        source: "discord",
        type: ChannelType.GROUP,
      },
    ]);
    await runtime.createRoomParticipants([alice, bob], roomId);

    const add = (
      entityId: UUID,
      memoryRoomId: UUID,
      text: string,
      tableName: string,
    ) =>
      runtime.createMemory(
        {
          entityId,
          agentId,
          roomId: memoryRoomId,
          content: { text },
          metadata: { type: "custom", timestamp: Date.now() },
        },
        tableName,
      );
    await add(alice, roomId, "Alice drinks green tea", "facts");
    await add(bob, roomId, "Bob plays chess on Sundays", "facts");
    await add(
      alice,
      agentId,
      "be concise with alice",
      "user_personality_preferences",
    );
    await add(
      bob,
      agentId,
      "use a formal tone with bob",
      "user_personality_preferences",
    );

    const service = createNativeRelationshipsGraphService(runtime, {
      async searchContacts() {
        return [{ entityId: alice }, { entityId: bob }];
      },
      async getContact(entityId: UUID) {
        return { entityId };
      },
      async getCandidateMerges() {
        return [];
      },
    });

    const detail = await service.getPersonDetail(alice);

    expect(detail?.factCount).toBe(1);
    expect(
      detail?.facts
        .filter((fact) => fact.sourceType === "memory")
        .map((fact) => fact.text),
    ).toEqual(["Alice drinks green tea"]);
    expect(
      detail?.userPersonalityPreferences.map((preference) => preference.text),
    ).toEqual(["be concise with alice"]);

    const clusterFacts = await getMemoriesForCluster(runtime, alice, {
      tableName: "facts",
    });
    expect(clusterFacts.map((memory) => memory.content.text)).toEqual([
      "Alice drinks green tea",
    ]);
  }, 60_000);
});
