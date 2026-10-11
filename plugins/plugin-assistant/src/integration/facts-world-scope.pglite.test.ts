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
import { afterEach, describe, expect, it, vi } from "vitest";
import { factsProvider } from "../features/advanced-capabilities/providers/facts.ts";
import {
  FACTS_AND_RELATIONSHIPS_TOOL_NAME,
  runFactsAndRelationshipsStage,
} from "../runtime/facts-and-relationships.ts";

const EXTRACTED_FACT = "Dana keeps the release checklist in the ops channel";

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
  const factsModelPlugin: Plugin = {
    name: "facts-world-scope-model",
    description: "Deterministic facts-stage model response",
    models: {
      [ModelType.TEXT_LARGE]: async () => ({
        text: "",
        toolCalls: [
          {
            name: FACTS_AND_RELATIONSHIPS_TOOL_NAME,
            arguments: {
              facts: [{ subject: "user", fact: EXTRACTED_FACT }],
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
    plugins: [sqlPlugin, factsModelPlugin],
  });
}

describe("FACTS provider on connector messages that carry a worldId", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  it("shows another participant's room fact the facts stage stored in that room", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-10T12:00:00.000Z"),
      toFake: ["Date"],
    });
    const runtime = createRuntime();
    runtimes.push(runtime);
    runtime.registerDatabaseAdapter(
      await createMigratedAdapter(runtime.agentId),
    );
    await runtime.initialize({ skipMigrations: true });

    const userId = uuidv4() as UUID;
    const askerId = uuidv4() as UUID;
    const roomId = uuidv4() as UUID;
    const worldId = uuidv4() as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      worldName: "Guild",
      roomName: "ops",
      userName: "dana",
      name: "Dana",
      source: "discord",
      type: ChannelType.GROUP,
      channelId: "ops-channel",
    });
    await runtime.ensureConnection({
      entityId: askerId,
      roomId,
      worldId,
      worldName: "Guild",
      roomName: "ops",
      userName: "carol",
      name: "Carol",
      source: "discord",
      type: ChannelType.GROUP,
      channelId: "ops-channel",
    });

    const statement: Memory = {
      id: uuidv4() as UUID,
      entityId: userId,
      agentId: runtime.agentId,
      roomId,
      worldId,
      content: {
        text: "I keep the release checklist in the ops channel.",
        source: "discord",
        senderName: "Dana",
      },
      createdAt: Date.now(),
    };
    await runtime.createMemory(statement, "messages");

    const stage = await runFactsAndRelationshipsStage({
      runtime,
      message: statement,
      state: { values: {}, data: {}, text: "" } as State,
      extract: { facts: [EXTRACTED_FACT], relationships: [] },
    });
    expect(stage.written.facts).toBe(1);

    const followUp: Memory = {
      id: uuidv4() as UUID,
      entityId: askerId,
      agentId: runtime.agentId,
      roomId,
      worldId,
      content: {
        text: "Where does Dana keep the release checklist?",
        source: "discord",
        senderName: "Carol",
      },
      createdAt: Date.now() + 1,
    };
    await runtime.createMemory(followUp, "messages");

    const result = await factsProvider.get(runtime, followUp, {
      values: {},
      data: {},
      text: "",
    } as State);

    expect(result.text).toBe(
      `What's currently happening in this room:\n[current.uncategorized since 2026-10-10 conf=0.60] ${EXTRACTED_FACT}`,
    );
  });
});
