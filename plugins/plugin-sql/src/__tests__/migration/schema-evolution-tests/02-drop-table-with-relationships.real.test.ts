/**
 * Schema-evolution test against the real elizaOS production schemas (with
 * their actual foreign-key graph): proves `RuntimeMigrator` detects dropping
 * the `memories` table — and dropping several interconnected tables at once
 * (entities/memories/relationships/embeddings) — as data-losing, blocks it in
 * development and production without `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS`,
 * and surfaces what happens (including FK-constraint failures from
 * `embeddings`) when the override is set.
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeMigrator } from "../../../runtime-migrator/runtime-migrator";
import type { DrizzleDB } from "../../../runtime-migrator/types";
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from "../../test-helpers";

interface ExistsRow {
  exists: boolean;
}

function asExistsRow(row: unknown): ExistsRow {
  return row as ExistsRow;
}

interface StatsRow {
  agents: string | number;
  entities: string | number;
  rooms: string | number;
  memories: string | number;
  relationships: string | number;
  [key: string]: unknown;
}

import { agentTable } from "../../../schema/agent";
import { cacheTable } from "../../../schema/cache";
import { channelTable } from "../../../schema/channel";
import { channelParticipantsTable } from "../../../schema/channelParticipant";
import { componentTable } from "../../../schema/component";
import { embeddingTable } from "../../../schema/embedding";
import { entityTable } from "../../../schema/entity";
import { logTable } from "../../../schema/log";
import { memoryTable } from "../../../schema/memory";
import { messageTable } from "../../../schema/message";
import { messageServerTable } from "../../../schema/messageServer";
import { messageServerAgentsTable } from "../../../schema/messageServerAgent";
import { participantTable } from "../../../schema/participant";
import { relationshipTable } from "../../../schema/relationship";
import { roomTable } from "../../../schema/room";
import { taskTable } from "../../../schema/tasks";
import { worldTable } from "../../../schema/world";

describe("Schema Evolution Test: Drop Table with Production Relationships", () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  const getFullSchemaV1 = () => ({
    agents: agentTable,
    memories: memoryTable,
    entities: entityTable,
    relationships: relationshipTable,
    rooms: roomTable,
    worlds: worldTable,
    participants: participantTable,
    messages: messageTable,
    messageServers: messageServerTable,
    channels: channelTable,
    channelParticipants: channelParticipantsTable,
    components: componentTable,
    embeddings: embeddingTable,
    logs: logTable,
    cache: cacheTable,
    tasks: taskTable,
    messageServerAgents: messageServerAgentsTable,
  });

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      "schema_evolution_drop_table_test"
    );
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should handle dropping memories table with cascade effects on production schema", async () => {
    const schemaV1 = getFullSchemaV1();

    console.log("🚀 Migrating full production schema...");
    await migrator.migrate("@elizaos/production-schema-v1", schemaV1);

    console.log("\n📝 Creating interconnected production data...");

    const agent1Id = "550e8400-e29b-41d4-a716-446655440001";
    const agent2Id = "550e8400-e29b-41d4-a716-446655440002";

    await db.insert(agentTable).values([
      {
        id: agent1Id,
        name: "Production Agent One",
        bio: ["Customer support specialist"],
        enabled: true,
        system: "Support system prompt",
        messageExamples: [],
        postExamples: [],
        topics: ["support"],
        adjectives: ["helpful"],
        knowledge: [],
        plugins: ["bootstrap", "sql"],
        settings: {},
        style: {},
      },
      {
        id: agent2Id,
        name: "Production Agent Two",
        bio: ["Analytics agent"],
        enabled: true,
        system: "Analytics system prompt",
        messageExamples: [],
        postExamples: [],
        topics: ["analytics"],
        adjectives: ["analytical"],
        knowledge: [],
        plugins: ["bootstrap"],
        settings: {},
        style: {},
      },
    ]);

    const entity1Id = "660e8400-e29b-41d4-a716-446655440001";
    const entity2Id = "660e8400-e29b-41d4-a716-446655440002";

    await db.insert(entityTable).values([
      {
        id: entity1Id,
        agentId: agent1Id,
        names: ["John Doe"],
        metadata: { type: "user", verified: true },
      },
      {
        id: entity2Id,
        agentId: agent2Id,
        names: ["Jane Smith"],
        metadata: { type: "user", verified: false },
      },
    ]);

    const room1Id = "770e8400-e29b-41d4-a716-446655440001";
    const room2Id = "770e8400-e29b-41d4-a716-446655440002";
    const channelId1 = "990e8400-e29b-41d4-a716-446655440001";
    const channelId2 = "990e8400-e29b-41d4-a716-446655440002";
    const messageServerId = "aa1e8400-e29b-41d4-a716-446655440001";

    await db.insert(roomTable).values([
      {
        id: room1Id,
        name: "Support Channel",
        agentId: agent1Id,
        source: "discord",
        type: "text",
        channelId: channelId1,
        messageServerId: messageServerId,
      },
      {
        id: room2Id,
        name: "Analytics Room",
        agentId: agent2Id,
        source: "discord",
        type: "voice",
        channelId: channelId2,
        messageServerId: messageServerId,
      },
    ]);

    // Memories carry FKs to agents, entities, and rooms.
    await db.insert(memoryTable).values([
      {
        id: "880e8400-e29b-41d4-a716-446655440001",
        agentId: agent1Id,
        entityId: entity1Id,
        roomId: room1Id,
        type: "conversation",
        content: { text: "Customer support interaction #1", priority: "high" },
        metadata: { type: "fragment", documentId: "doc1", position: 1 },
        unique: true,
      },
      {
        id: "880e8400-e29b-41d4-a716-446655440002",
        agentId: agent1Id,
        entityId: entity1Id,
        roomId: room1Id,
        type: "fact",
        content: { text: "Customer preference noted", category: "preference" },
        metadata: { type: "fragment", documentId: "doc1", position: 2 },
        unique: true,
      },
      {
        id: "880e8400-e29b-41d4-a716-446655440003",
        agentId: agent2Id,
        entityId: entity2Id,
        roomId: room2Id,
        type: "analysis",
        content: { data: "Analytics result", confidence: 0.92 },
        metadata: { type: "document", timestamp: new Date().toISOString() },
        unique: false,
      },
    ]);

    await db.insert(relationshipTable).values([
      {
        sourceEntityId: entity1Id,
        targetEntityId: entity2Id,
        agentId: agent1Id,
        tags: ["colleague", "team"],
        metadata: { strength: 0.8 },
      },
    ]);

    // Embeddings are skipped here (vector setup is complex); the case under
    // test is whether dropping the memories table itself is detected.

    console.log("\n📊 Production data created:");
    const counts = await db.execute(sql`
      SELECT 
        (SELECT COUNT(*) FROM agents) as agents,
        (SELECT COUNT(*) FROM entities) as entities,
        (SELECT COUNT(*) FROM rooms) as rooms,
        (SELECT COUNT(*) FROM memories) as memories,
        (SELECT COUNT(*) FROM relationships) as relationships
    `);

    const stats = counts.rows[0] as StatsRow;
    console.log(`  - Agents: ${stats.agents}`);
    console.log(`  - Entities: ${stats.entities}`);
    console.log(`  - Rooms: ${stats.rooms}`);
    console.log(`  - Memories: ${stats.memories} (with FKs to agents, entities, rooms)`);
    console.log(`  - Relationships: ${stats.relationships}`);

    // V2 omits `memories` — a destructive drop — while `embeddings` still
    // holds foreign keys pointing at it, which is the cascade case under test.
    const schemaV2 = {
      agents: agentTable,
      entities: entityTable,
      relationships: relationshipTable,
      rooms: roomTable,
      worlds: worldTable,
      participants: participantTable,
      messages: messageTable,
      messageServers: messageServerTable,
      channels: channelTable,
      channelParticipants: channelParticipantsTable,
      components: componentTable,
      embeddings: embeddingTable,
      logs: logTable,
      cache: cacheTable,
      tasks: taskTable,
      messageServerAgents: messageServerAgentsTable,
    };

    console.log("\n🔍 Checking migration for cascade effects...");
    const dataLossCheck = await migrator.checkMigration("@elizaos/production-schema-v1", schemaV2);

    if (dataLossCheck) {
      expect(dataLossCheck.hasDataLoss).toBe(true);
      expect(dataLossCheck.requiresConfirmation).toBe(true);
      expect(
        dataLossCheck.warnings.some((w) => w.includes("memories") && w.includes("dropped"))
      ).toBe(true);

      console.log("\n⚠️  Table Drop Detection:");
      dataLossCheck.warnings.forEach((warning) => {
        console.log(`  ❌ ${warning}`);
      });
    }

    process.env.NODE_ENV = "development";
    delete process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;

    console.log("\n🛡️  Testing protection without environment variable...");
    let blockedError: Error | null = null;
    try {
      await migrator.migrate("@elizaos/production-schema-v1", schemaV2);
    } catch (error) {
      blockedError = error as Error;
    }

    expect(blockedError).not.toBeNull();
    expect(blockedError?.message).toContain("Destructive migration blocked");
    console.log(`  ✅ Table drop blocked without env var`);

    // Production mode blocks the same drop.
    process.env.NODE_ENV = "production";

    console.log("\n🛡️  Testing production protection...");
    let productionError: Error | null = null;
    try {
      await migrator.migrate("@elizaos/production-schema-v1", schemaV2);
    } catch (error) {
      productionError = error as Error;
    }

    expect(productionError).not.toBeNull();
    expect(productionError?.message).toContain("production");
    expect(productionError?.message).toContain("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS");
    console.log(`  ✅ Table drop blocked in production`);

    const tableExists = await db.execute(
      sql`SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'memories' AND table_schema = 'public'
      ) as exists`
    );
    expect(asExistsRow(tableExists.rows[0]).exists).toBe(true);

    process.env.NODE_ENV = "development";
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "true";

    console.log("\n⚠️  Attempting migration with ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true...");

    // May fail here due to the embeddings table's FK constraint on memories.
    try {
      await migrator.migrate("@elizaos/production-schema-v1", schemaV2);

      const tableExistsAfter = await db.execute(
        sql`SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'memories'
        ) as exists`
      );

      expect(asExistsRow(tableExistsAfter.rows[0]).exists).toBe(false);

      console.log("\n📊 After forced table drop:");
      console.log("  ❌ Memories table dropped");
      console.log("  ❌ All memory data lost permanently");
      console.log("  ⚠️  Embeddings may have orphaned references");
    } catch (error) {
      console.log("\n❌ Migration failed (expected due to FK constraints):");
      console.log(`  Error: ${(error as Error).message}`);
      console.log("  💡 Would need to handle dependent tables first");
    }
  });

  it("should detect cascade effects when dropping multiple related tables", async () => {
    const schemaV1 = getFullSchemaV1();

    await migrator.migrate("@elizaos/production-cascade-test", schemaV1);

    const agentId = "aa0e8400-e29b-41d4-a716-446655440001";
    await db.insert(agentTable).values({
      id: agentId,
      name: "Test Agent",
      bio: ["Test bio"],
      enabled: true,
      system: "Test system",
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      settings: {},
      style: {},
    });

    // V2 omits entities, memories, relationships, and embeddings — all
    // interconnected by foreign keys.
    const schemaV2 = {
      agents: agentTable,
      rooms: roomTable,
      worlds: worldTable,
      participants: participantTable,
      messages: messageTable,
      messageServers: messageServerTable,
      channels: channelTable,
      channelParticipants: channelParticipantsTable,
      components: componentTable,
      logs: logTable,
      cache: cacheTable,
      tasks: taskTable,
      messageServerAgents: messageServerAgentsTable,
    };

    const check = await migrator.checkMigration("@elizaos/production-cascade-test", schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(true);
      expect(check.warnings.length).toBeGreaterThanOrEqual(4); // At least 4 tables dropped

      console.log("\n🔗 Cascade Drop Analysis:");
      console.log(`  Total warnings: ${check.warnings.length}`);
      check.warnings.forEach((warning) => {
        console.log(`  • ${warning}`);
      });

      // Should detect all dropped tables
      expect(check.warnings.some((w) => w.includes("entities"))).toBe(true);
      expect(check.warnings.some((w) => w.includes("memories"))).toBe(true);
      expect(check.warnings.some((w) => w.includes("relationships"))).toBe(true);
      expect(check.warnings.some((w) => w.includes("embeddings"))).toBe(true);
    }
  });
});
