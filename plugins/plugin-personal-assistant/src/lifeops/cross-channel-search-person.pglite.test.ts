/**
 * A person-scoped cross-channel search returns that person's messages only.
 * `getMemories({ entityId })` names the isolation principal, not the speaker,
 * so the fallback cluster read must also pass `authorEntityIds`. Real PGlite
 * message store; only person resolution (the relationships graph) is stubbed.
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
import { afterEach, expect, it } from "vitest";
import { runCrossChannelSearch } from "./cross-channel-search.js";

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

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
  runtimes.push(runtime);
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  const adapter = new PgliteDatabaseAdapter(runtime.agentId, manager);
  runtime.registerDatabaseAdapter(adapter);
  await adapter.init();
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrations.discoverAndRegisterPluginSchemas([
    { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
  ]);
  await migrations.runAllPluginMigrations();
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

it("returns only the named person's messages, not every speaker's", async () => {
  const runtime = await createRuntime();
  const agentId = runtime.agentId;
  const alice = crypto.randomUUID() as UUID;
  const bob = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const roomId = crypto.randomUUID() as UUID;
  await runtime.createEntities([
    { id: alice, agentId, names: ["Alice"], metadata: {} },
    { id: bob, agentId, names: ["Bob"], metadata: {} },
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
      source: "telegram",
      type: ChannelType.GROUP,
      worldId,
    },
  ]);
  for (const [entityId, text] of [
    [alice, "Alice: the contract is signed"],
    [bob, "Bob: my bank PIN is 4412"],
  ] as const) {
    await runtime.createMemory(
      {
        id: crypto.randomUUID() as UUID,
        agentId,
        entityId,
        roomId,
        content: { text, source: "telegram" },
        createdAt: Date.now(),
      },
      "messages",
    );
  }
  const getService = runtime.getService.bind(runtime);
  runtime.getService = ((name: string) =>
    name === "relationships"
      ? {
          getGraphSnapshot: async () => ({ people: [] }),
          getPersonDetail: async (id: UUID) => ({
            primaryEntityId: id,
            memberEntityIds: [id],
            displayName: "Alice",
            aliases: [],
            platforms: [],
            identities: [],
          }),
        }
      : getService(name)) as typeof runtime.getService;

  const result = await runCrossChannelSearch(runtime, {
    query: "what did Alice say",
    personRef: { primaryEntityId: alice },
    channels: ["telegram"],
  });

  const texts = result.hits.map((hit) => hit.text);
  expect(texts).toContain("Alice: the contract is signed");
  expect(texts).not.toContain("Bob: my bank PIN is 4412");
});
