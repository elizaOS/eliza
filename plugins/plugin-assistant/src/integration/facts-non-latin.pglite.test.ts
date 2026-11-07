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

type ExtractedRelationship = {
  subject: string;
  predicate: string;
  object: string;
};

function createRuntime(
  fact: string,
  relationships: ExtractedRelationship[] = [],
): AgentRuntime {
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
              facts: fact ? [{ subject: "user", fact }] : [],
              relationships,
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

  async function prepareRoom(
    fact: string,
    text: string,
    relationships: ExtractedRelationship[] = [],
  ): Promise<{ runtime: AgentRuntime; statement: Memory; roomId: UUID }> {
    const runtime = createRuntime(fact, relationships);
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

    return { runtime, statement, roomId };
  }

  it.each([
    ["Korean", "나는 녹차를 좋아해", "사용자는 녹차를 좋아한다"],
    ["Japanese", "私は緑茶が好きです", "ユーザーは緑茶が好きです"],
    ["English", "I like green tea.", "The user likes green tea"],
  ])("%s fact is validated and stored", async (_label, text, fact) => {
    const { runtime, statement, roomId } = await prepareRoom(fact, text);
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

  // One Hangul, Han or kana character carries a syllable or word, so a two
  // character name or a three character fact clears the low-signal floor.
  it.each([
    ["Korean name", "지호", "내 친구 지호는 의사야"],
    ["Korean full name", "김지호", "내 친구 김지호는 의사야"],
    ["Japanese name", "田中", "友達の田中は医者です"],
    ["Chinese name", "王伟", "我的朋友王伟是医生"],
  ])("%s relationship object is stored", async (_label, object, text) => {
    const relationship = { subject: "user", predicate: "friend_of", object };
    const { runtime, statement, roomId } = await prepareRoom("", text, [
      relationship,
    ]);

    const stage = await runFactsAndRelationshipsStage({
      runtime,
      message: statement,
      state: { values: {}, data: {}, text: "" } as State,
      extract: { facts: [], relationships: [relationship] },
    });
    expect(stage.parsed.thought).not.toBe("no candidates after filtering");
    expect(stage.written.relationships).toBe(1);

    const rows = await runtime.getMemories({
      tableName: "facts",
      roomId,
      count: 10,
    });
    expect(rows.map((row) => row.content.object)).toEqual([object]);
  });

  it("short Japanese fact is stored", async () => {
    const fact = "犬好き";
    const { runtime, statement, roomId } = await prepareRoom(
      fact,
      "私は犬好きです",
    );

    const stage = await runFactsAndRelationshipsStage({
      runtime,
      message: statement,
      state: { values: {}, data: {}, text: "" } as State,
      extract: { facts: [fact], relationships: [] },
    });
    expect(stage.written.facts).toBe(1);

    const rows = await runtime.getMemories({
      tableName: "facts",
      roomId,
      count: 10,
    });
    expect(rows.map((row) => row.content.text)).toEqual([fact]);
  });

  it.each([
    ["three-letter English name", "Bob"],
    ["single Han character", "犬"],
  ])("%s relationship object stays below the floor", async (_label, object) => {
    const relationship = { subject: "user", predicate: "friend_of", object };
    const { runtime, statement } = await prepareRoom(
      "",
      `my friend ${object}`,
      [relationship],
    );

    const stage = await runFactsAndRelationshipsStage({
      runtime,
      message: statement,
      state: { values: {}, data: {}, text: "" } as State,
      extract: { facts: [], relationships: [relationship] },
    });
    expect(stage.parsed.thought).toBe("no candidates after filtering");
    expect(stage.written.relationships).toBe(0);
  });
});
