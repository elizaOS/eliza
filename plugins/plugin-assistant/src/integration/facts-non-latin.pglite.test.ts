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

function createRuntime(fact: string): AgentRuntime {
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
    name: "facts-non-latin-model",
    description: "Deterministic facts-stage validation response",
    models: {
      [ModelType.TEXT_LARGE]: async () => ({
        text: "",
        toolCalls: [
          {
            name: FACTS_AND_RELATIONSHIPS_TOOL_NAME,
            arguments: {
              facts: [{ subject: "user", fact }],
              relationships: [],
              thought: "new durable fact about the speaker",
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

describe("facts stage keeps facts written in non-Latin scripts", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  it.each([
    ["Korean", "나는 녹차를 좋아해", "사용자는 녹차를 좋아한다"],
    ["Japanese", "私は緑茶が好きです", "ユーザーは緑茶が好きです"],
    ["English", "I like green tea.", "The user likes green tea"],
  ])("%s fact is validated and stored", async (_label, text, fact) => {
    const runtime = createRuntime(fact);
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
      content: { text, source: "discord", senderName: "Minji" },
      createdAt: Date.now(),
    };
    await runtime.createMemory(statement, "messages");

    const stage = await runFactsAndRelationshipsStage({
      runtime,
      message: statement,
      state: { values: {}, data: {}, text: "" } as State,
      extract: { facts: [fact], relationships: [] },
    });
    expect(stage.parsed.thought).not.toBe("no candidates after filtering");
    expect(stage.written.facts).toBe(1);

    const rows = await runtime.getMemories({
      tableName: "facts",
      roomId,
      count: 10,
    });
    expect(rows.map((row) => row.content.text)).toEqual([fact]);
  });
});
