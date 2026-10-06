/**
 * Real-PGlite coverage for per-person graph reads: `getMemories({ entityId })`
 * names the isolation principal, not the associated subject, so person reads
 * also select stored entity IDs. Shared rooms, third-person claims, merged
 * identities, and bounded semantic search retain their canonical scope.
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
import { RelationshipsService } from "./relationships.ts";
import {
  createNativeRelationshipsGraphService,
  getMemoriesForCluster,
  searchMemoriesForCluster,
} from "./relationships-graph-builder.ts";

async function createRuntime(runtimes: AgentRuntime[]): Promise<AgentRuntime> {
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
  runtimes.push(runtime);
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  const adapter = new PgliteDatabaseAdapter(runtime.agentId, manager);
  runtime.registerDatabaseAdapter(adapter);
  await adapter.init();
  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrationService.discoverAndRegisterPluginSchemas([
    { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
  ]);
  await migrationService.runAllPluginMigrations();
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

describe("relationships graph author scope", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  it("retains subject facts, preferences and confirmed identity members", async () => {
    const runtime = await createRuntime(runtimes);
    const agentId = runtime.agentId;
    const alice = uuidv4() as UUID;
    const bob = uuidv4() as UUID;
    const aliceAlt = uuidv4() as UUID;
    const worldId = uuidv4() as UUID;
    const roomId = uuidv4() as UUID;
    await runtime.createEntities([
      { id: alice, agentId, names: ["alice"], metadata: {} },
      { id: bob, agentId, names: ["bob"], metadata: {} },
      { id: aliceAlt, agentId, names: ["alice alternate"], metadata: {} },
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
    await runtime.createRoomParticipants([alice, bob, aliceAlt], roomId);

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

    // The facts writer associates a resolved third-person claim with its
    // subject, while retaining the supplying message as provenance.
    const bobMessageId = uuidv4() as UUID;
    await runtime.createMemory(
      {
        entityId: alice,
        agentId,
        roomId,
        content: { text: "Alice works as a botanist", type: "fact" },
        metadata: {
          type: "custom",
          messageId: bobMessageId,
          subject: "alice",
          subjectResolved: true,
        },
      },
      "facts",
      true,
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

    expect(detail?.factCount).toBe(2);
    expect(
      detail?.facts
        .filter((fact) => fact.sourceType === "memory")
        .map((fact) => fact.text)
        .sort(),
    ).toEqual(["Alice drinks green tea", "Alice works as a botanist"].sort());
    expect(
      detail?.userPersonalityPreferences.map((preference) => preference.text),
    ).toEqual(["be concise with alice"]);

    const clusterFacts = await getMemoriesForCluster(runtime, alice, {
      tableName: "facts",
    });
    expect(clusterFacts.map((memory) => memory.content.text).sort()).toEqual(
      ["Alice drinks green tea", "Alice works as a botanist"].sort(),
    );
    expect(
      clusterFacts.find(
        (memory) => memory.content.text === "Alice works as a botanist",
      )?.metadata?.messageId,
    ).toBe(bobMessageId);
    await add(aliceAlt, roomId, "Alice alternate has a greenhouse", "facts");
    await runtime.createRelationship({
      sourceEntityId: alice,
      targetEntityId: aliceAlt,
      tags: ["identity_link"],
      metadata: { status: "confirmed" },
    });
    await runtime.registerService(RelationshipsService);
    runtime.getService("relationships");
    await runtime.getServiceLoadPromise("relationships");
    const merged = await getMemoriesForCluster(runtime, alice, {
      tableName: "facts",
    });
    expect(merged.map((memory) => memory.content.text).sort()).toEqual(
      [
        "Alice drinks green tea",
        "Alice works as a botanist",
        "Alice alternate has a greenhouse",
      ].sort(),
    );
    // A closer unrelated vector must not consume a member's explicit limit.
    const embedding = Array(384).fill(0.1);
    for (const [entityId, text, vector] of [
      [bob, "Unrelated exact vector", embedding],
      [
        alice,
        "Alice semantic fact",
        embedding.map((value, index) => (index === 0 ? 0.2 : value)),
      ],
      [
        aliceAlt,
        "Alice alternate semantic fact",
        embedding.map((value, index) => (index === 1 ? 0.2 : value)),
      ],
    ] as const) {
      await runtime.createMemory(
        {
          entityId,
          agentId,
          roomId,
          content: { text },
          embedding: [...vector],
          metadata: { type: "custom" },
        },
        "semantic_facts",
        true,
      );
    }
    const semantic = await searchMemoriesForCluster(runtime, alice, {
      tableName: "semantic_facts",
      embedding,
      limit: 1,
    });
    expect(semantic.map((memory) => memory.content.text).sort()).toEqual(
      ["Alice semantic fact", "Alice alternate semantic fact"].sort(),
    );
  });
});
