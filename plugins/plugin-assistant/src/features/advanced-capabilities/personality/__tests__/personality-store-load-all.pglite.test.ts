/**
 * Real-PGlite coverage for loading personality slots: a store started on an
 * agent with more than 10,000 stored slots must load every slot. A slot that
 * is not loaded reads as empty, and the next write to it replaces the stored
 * slot. The extra slots are bulk-copied in SQL from one real slot row.
 */
import { AgentRuntime, type Character, type UUID } from "@elizaos/core";
import type { DrizzleDatabase } from "@elizaos/plugin-sql";
import {
  DatabaseMigrationService,
  PGliteClientManager,
  PgliteDatabaseAdapter,
  schema,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterEach, expect, it } from "vitest";
import { PersonalityStore } from "../services/personality-store.ts";

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

async function createRuntime() {
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
  runtimes.push(runtime);
  return { runtime, db: adapter.getDatabase() as DrizzleDatabase };
}

it("loads the owner's slot behind 10,000 newer slots and keeps it on the next write", async () => {
  const { runtime, db } = await createRuntime();
  const agentId = runtime.agentId;
  const owner = uuidv4() as UUID;
  await runtime.createEntities([
    { id: owner, agentId, names: ["owner"], metadata: {} },
  ]);
  const first = await PersonalityStore.start(runtime);
  await first.applyTrait({
    scope: "user",
    userId: owner,
    agentId,
    actorId: owner,
    trait: "verbosity",
    value: "terse",
  });

  // 10,000 newer slots for other users, copied from the owner's real row.
  await db.execute(sql`
    INSERT INTO memories (id, type, created_at, content, entity_id, agent_id, room_id, world_id, "unique", metadata)
    SELECT gen_random_uuid(), m.type, m.created_at + make_interval(secs => g), m.content,
      m.entity_id, m.agent_id, m.room_id, m.world_id, m."unique",
      jsonb_set(m.metadata, '{slot,userId}', to_jsonb(gen_random_uuid()::text))
    FROM memories m, generate_series(1, 10000) g
    WHERE m.agent_id = ${agentId} AND m.metadata->>'source' = 'personality_slot'
  `);

  // A restarted store loads every slot.
  const restarted = await PersonalityStore.start(runtime);
  expect(restarted.getSlot(owner, agentId).verbosity).toBe("terse");

  // The next write keeps the stored trait instead of starting from empty.
  await restarted.applyTrait({
    scope: "user",
    userId: owner,
    agentId,
    actorId: owner,
    trait: "tone",
    value: "warm",
  });
  const again = await PersonalityStore.start(runtime);
  expect(again.getSlot(owner, agentId)).toMatchObject({
    verbosity: "terse",
    tone: "warm",
  });
}, 300_000);
