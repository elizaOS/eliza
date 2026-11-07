import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Memory,
  ModelType,
  type Plugin,
  type State,
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
  FACTS_AND_RELATIONSHIPS_TOOL_NAME,
  runFactsAndRelationshipsStage,
} from "../runtime/facts-and-relationships.ts";

const RELATIONSHIP = {
  subject: "user",
  predicate: "好き",
  object: "agent",
};

async function createMigratedAdapter(
  agentId: UUID,
): Promise<PgliteDatabaseAdapter> {
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  await adapter.init();
  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrationService.discoverAndRegisterPluginSchemas([
    { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
  ]);
  await migrationService.runAllPluginMigrations();
  return adapter;
}

function createRuntime(): AgentRuntime {
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
  const validatorModel: Plugin = {
    name: "facts-non-latin-relationships-model",
    description: "Deterministic relationship validation response",
    models: {
      [ModelType.TEXT_LARGE]: async () => ({
        text: "",
        toolCalls: [
          {
            name: FACTS_AND_RELATIONSHIPS_TOOL_NAME,
            arguments: {
              facts: [],
              relationships: [RELATIONSHIP],
              thought: "new relationship",
            },
          },
        ],
      }),
    },
  };
  return new AgentRuntime({
    character,
    plugins: [sqlPlugin, validatorModel],
  });
}

describe("facts stage preserves non-Latin relationship predicates", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  it("writes a Japanese relationship predicate through the real stage", async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);
    runtime.registerDatabaseAdapter(
      await createMigratedAdapter(runtime.agentId),
    );
    await runtime.initialize({ skipMigrations: true });

    const userId = uuidv4() as UUID;
    const roomId = uuidv4() as UUID;
    const worldId = uuidv4() as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      worldName: "Home",
      roomName: "chat",
      userName: "minji",
      name: "Minji",
      source: "discord",
      type: ChannelType.GROUP,
      channelId: "chat-channel",
    });

    const statement: Memory = {
      id: uuidv4() as UUID,
      entityId: userId,
      agentId: runtime.agentId,
      roomId,
      worldId,
      content: {
        text: "私は緑茶が好きです",
        source: "discord",
        senderName: "Minji",
      },
      createdAt: Date.now(),
    };
    await runtime.createMemory(statement, "messages");

    const stage = await runFactsAndRelationshipsStage({
      runtime,
      message: statement,
      state: { values: {}, data: {}, text: "" } as State,
      extract: { facts: [], relationships: [RELATIONSHIP] },
    });

    expect(stage.written.relationships).toBe(1);
    const rows = await runtime.getMemories({
      tableName: "facts",
      roomId,
      count: 10,
    });
    expect(
      rows.filter((row) => row.content.predicate === RELATIONSHIP.predicate),
    ).toHaveLength(1);
  });
});
