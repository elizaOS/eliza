/**
 * Real-PGlite coverage for per-user interaction preferences: the CHARACTER
 * modify path must only read, count, and reset the sender's own preference
 * rows, never other users' rows stored in the same agent-scoped table.
 */
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  Service,
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
import { characterAction } from "../actions/character.ts";
import { PersonalityServiceType, USER_PREFS_TABLE } from "../types.ts";

class StubCharacterManagementService extends Service {
  static serviceType = PersonalityServiceType.CHARACTER_MANAGEMENT;
  capabilityDescription = "Character management stub for preference tests";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new StubCharacterManagementService(runtime);
  }

  async stop(): Promise<void> {}
}

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
  const testPlugin: Plugin = {
    name: "user-preference-scope-test",
    description: "Preference scope test plugin",
    services: [StubCharacterManagementService],
    models: {
      [ModelType.TEXT_SMALL]: async () => JSON.stringify({ action: "reset" }),
    },
  };
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, testPlugin],
  });
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

describe("CHARACTER per-user preferences", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  it("resets only the requesting user's preferences", async () => {
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
      metadata: { roles: { [alice]: "ADMIN" } },
    });
    await runtime.createRooms([
      {
        id: roomId,
        name: "Room",
        agentId,
        worldId,
        source: "discord",
        type: ChannelType.GROUP,
      },
    ]);
    await runtime.createRoomParticipants([alice, bob], roomId);

    const addPreference = (entityId: UUID, text: string) =>
      runtime.createMemory(
        {
          entityId,
          agentId,
          roomId: agentId,
          content: { text, source: "user_personality_preference" },
          metadata: { type: "custom", timestamp: Date.now() },
        },
        USER_PREFS_TABLE,
      );
    await addPreference(alice, "be concise with alice");
    await addPreference(bob, "use a formal tone with bob");
    await addPreference(bob, "no emoji for bob");
    const preferencesOf = async (entityId: UUID) =>
      (
        await runtime.getMemories({
          tableName: USER_PREFS_TABLE,
          roomId: agentId,
          entityId,
          authorEntityIds: [entityId],
        })
      ).map((memory) => memory.content.text);

    const message: Memory = {
      id: uuidv4() as UUID,
      entityId: alice,
      agentId,
      roomId,
      worldId,
      content: { text: "reset my interaction preferences", source: "discord" },
      createdAt: Date.now(),
    };
    const result = await characterAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { action: "modify", scope: "user" } },
      async () => [],
    );

    expect(result?.text).toBe("Reset 1 preferences");
    expect(await preferencesOf(alice)).toEqual([]);
    expect((await preferencesOf(bob)).sort()).toEqual([
      "no emoji for bob",
      "use a formal tone with bob",
    ]);
  }, 60_000);
});
