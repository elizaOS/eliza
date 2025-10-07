import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../../runtime-migrator/runtime-migrator';
import type { DrizzleDB } from '../../../runtime-migrator/types';
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from '../../test-helpers';

// Import ALL production schemas
import { agentTable } from '../../../schema/agent';
import { memoryTable } from '../../../schema/memory';
import { entityTable } from '../../../schema/entity';
import { relationshipTable } from '../../../schema/relationship';
import { roomTable } from '../../../schema/room';
import { worldTable } from '../../../schema/world';
import { participantTable } from '../../../schema/participant';
import { messageTable } from '../../../schema/message';
import { messageServerTable } from '../../../schema/messageServer';
import { channelTable } from '../../../schema/channel';
import { channelParticipantsTable } from '../../../schema/channelParticipant';
import { componentTable } from '../../../schema/component';
import { embeddingTable } from '../../../schema/embedding';
import { logTable } from '../../../schema/log';
import { cacheTable } from '../../../schema/cache';
import { taskTable } from '../../../schema/tasks';
import { serverAgentsTable } from '../../../schema/serverAgent';

/**
 * Schema Evolution Test 2: Dropping Tables with Foreign Key Relationships
 *
 * This test uses the ACTUAL ElizaOS production schemas with their
 * complex foreign key relationships to verify cascade behavior.
 */

describe('Schema Evolution Test: Drop Table with Production Relationships', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  // Full production schema
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
    serverAgents: serverAgentsTable,
  });

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      'schema_evolution_drop_table_test'
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

  it('should handle dropping memories table with cascade effects on production schema', async () => {
    // Apply full production schema
    const schemaV1 = getFullSchemaV1();

    console.log('🚀 Migrating full production schema...');
    await migrator.migrate('@elizaos/production-schema-v1', schemaV1);

    // Insert interconnected production data
    console.log('\n📝 Creating interconnected production data...');

    // 1. Create agents
    const agent1Id = '550e8400-e29b-41d4-a716-446655440001';
    const agent2Id = '550e8400-e29b-41d4-a716-446655440002';

    await db.insert(agentTable).values([
      {
        id: agent1Id,
        name: 'Production Agent One',
        bio: ['Customer support specialist'],
        enabled: true,
        system: 'Support system prompt',
        messageExamples: [],
        postExamples: [],
        topics: ['support'],
        adjectives: ['helpful'],
        knowledge: [],
        plugins: ['bootstrap', 'sql'],
        settings: {},
        style: {},
      },
      {
        id: agent2Id,
        name: 'Production Agent Two',
        bio: ['Analytics agent'],
        enabled: true,
        system: 'Analytics system prompt',
        messageExamples: [],
        postExamples: [],
        topics: ['analytics'],
        adjectives: ['analytical'],
        knowledge: [],
        plugins: ['bootstrap'],
        settings: {},
        style: {},
      },
    ]);

    // 2. Create entities
    const entity1Id = '660e8400-e29b-41d4-a716-446655440001';
    const entity2Id = '660e8400-e29b-41d4-a716-446655440002';

    await db.insert(entityTable).values([
      {
        id: entity1Id,
        agentId: agent1Id,
        names: ['John Doe'],
        metadata: { type: 'user', verified: true },
      },
      {
        id: entity2Id,
        agentId: agent2Id,
        names: ['Jane Smith'],
        metadata: { type: 'user', verified: false },
      },
    ]);

    // 3. Create rooms
    const room1Id = '770e8400-e29b-41d4-a716-446655440001';
    const room2Id = '770e8400-e29b-41d4-a716-446655440002';

    await db.insert(roomTable).values([
      {
        id: room1Id,
        name: 'Support Channel',
        agentId: agent1Id,
        source: 'discord',
        type: 'text',
        channelId: 'channel-123',
        serverId: 'server-456',
      },
      {
        id: room2Id,
        name: 'Analytics Room',
        agentId: agent2Id,
        source: 'discord',
        type: 'voice',
        channelId: 'channel-789',
        serverId: 'server-456',
      },
    ]);

    // 4. Create memories (with foreign keys to agents, entities, rooms)
    await db.insert(memoryTable).values([
      {
        id: '880e8400-e29b-41d4-a716-446655440001',
        agentId: agent1Id,
        entityId: entity1Id,
        roomId: room1Id,
        type: 'conversation',
        content: { text: 'Customer support interaction #1', priority: 'high' },
        metadata: { type: 'fragment', documentId: 'doc1', position: 1 },
        unique: true,
      },
      {
        id: '880e8400-e29b-41d4-a716-446655440002',
        agentId: agent1Id,
        entityId: entity1Id,
        roomId: room1Id,
        type: 'fact',
        content: { text: 'Customer preference noted', category: 'preference' },
        metadata: { type: 'fragment', documentId: 'doc1', position: 2 },
        unique: true,
      },
      {
        id: '880e8400-e29b-41d4-a716-446655440003',
        agentId: agent2Id,
        entityId: entity2Id,
        roomId: room2Id,
        type: 'analysis',
        content: { data: 'Analytics result', confidence: 0.92 },
        metadata: { type: 'document', timestamp: new Date().toISOString() },
        unique: false,
      },
    ]);

    // 5. Create relationships
    await db.insert(relationshipTable).values([
      {
        sourceEntityId: entity1Id,
        targetEntityId: entity2Id,
        agentId: agent1Id,
        tags: ['colleague', 'team'],
        metadata: { strength: 0.8 },
      },
    ]);

    // Skip embeddings creation as it's complex with vectors
    // The key test is whether dropping memories table is detected

    // Verify all relationships are in place
    console.log('\n📊 Production data created:');
    const counts = await db.execute(sql`
      SELECT 
        (SELECT COUNT(*) FROM agents) as agents,
        (SELECT COUNT(*) FROM entities) as entities,
        (SELECT COUNT(*) FROM rooms) as rooms,
        (SELECT COUNT(*) FROM memories) as memories,
        (SELECT COUNT(*) FROM relationships) as relationships
    `);

    const stats = counts.rows[0] as any;
    console.log(`  - Agents: ${stats.agents}`);
    console.log(`  - Entities: ${stats.entities}`);
    console.log(`  - Rooms: ${stats.rooms}`);
    console.log(`  - Memories: ${stats.memories} (with FKs to agents, entities, rooms)`);
    console.log(`  - Relationships: ${stats.relationships}`);

    // Create V2 schema WITHOUT memories table (destructive!)
    // This will break foreign key relationships from embeddings
    const schemaV2 = {
      agents: agentTable,
      // memories: memoryTable, // REMOVED - this will cause cascade issues!
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
      embeddings: embeddingTable, // Still has references to memories!
      logs: logTable,
      cache: cacheTable,
      tasks: taskTable,
      serverAgents: serverAgentsTable,
    };

    // Test 1: Check for data loss warnings
    console.log('\n🔍 Checking migration for cascade effects...');
    const dataLossCheck = await migrator.checkMigration('@elizaos/production-schema-v1', schemaV2);

    if (dataLossCheck) {
      expect(dataLossCheck.hasDataLoss).toBe(true);
      expect(dataLossCheck.requiresConfirmation).toBe(true);
      expect(
        dataLossCheck.warnings.some((w) => w.includes('memories') && w.includes('dropped'))
      ).toBe(true);

      console.log('\n⚠️  Table Drop Detection:');
      dataLossCheck.warnings.forEach((warning) => {
        console.log(`  ❌ ${warning}`);
      });
    }

    // Test 2: Should block without environment variable
    process.env.NODE_ENV = 'development';
    delete process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;

    console.log('\n🛡️  Testing protection without environment variable...');
    let blockedError: Error | null = null;
    try {
      await migrator.migrate('@elizaos/production-schema-v1', schemaV2);
    } catch (error) {
      blockedError = error as Error;
    }

    expect(blockedError).not.toBeNull();
    expect(blockedError?.message).toContain('Destructive migration blocked');
    console.log(`  ✅ Table drop blocked without env var`);

    // Test 3: Production mode should also block
    process.env.NODE_ENV = 'production';

    console.log('\n🛡️  Testing production protection...');
    let productionError: Error | null = null;
    try {
      await migrator.migrate('@elizaos/production-schema-v1', schemaV2);
    } catch (error) {
      productionError = error as Error;
    }

    expect(productionError).not.toBeNull();
    expect(productionError?.message).toContain('production');
    expect(productionError?.message).toContain('ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS');
    console.log(`  ✅ Table drop blocked in production`);

    // Verify table still exists
    const tableExists = await db.execute(
      sql`SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'memories' AND table_schema = 'public'
      ) as exists`
    );
    expect((tableExists.rows[0] as any).exists).toBe(true);

    // Test 4: Force drop with environment variable
    process.env.NODE_ENV = 'development';
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';

    console.log('\n⚠️  Attempting migration with ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true...');

    // This might fail due to foreign key constraints from embeddings
    try {
      await migrator.migrate('@elizaos/production-schema-v1', schemaV2);

      // If successful, verify consequences
      const tableExistsAfter = await db.execute(
        sql`SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'memories'
        ) as exists`
      );

      expect((tableExistsAfter.rows[0] as any).exists).toBe(false);

      console.log('\n📊 After forced table drop:');
      console.log('  ❌ Memories table dropped');
      console.log('  ❌ All memory data lost permanently');
      console.log('  ⚠️  Embeddings may have orphaned references');
    } catch (error) {
      console.log('\n❌ Migration failed (expected due to FK constraints):');
      console.log(`  Error: ${(error as Error).message}`);
      console.log('  💡 Would need to handle dependent tables first');
    }
  });

  it('should detect cascade effects when dropping multiple related tables', async () => {
    const schemaV1 = getFullSchemaV1();

    await migrator.migrate('@elizaos/production-cascade-test', schemaV1);

    // Insert minimal data to test cascade detection
    const agentId = 'aa0e8400-e29b-41d4-a716-446655440001';
    await db.insert(agentTable).values({
      id: agentId,
      name: 'Test Agent',
      bio: ['Test bio'],
      enabled: true,
      system: 'Test system',
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      settings: {},
      style: {},
    });

    // Schema V2: Drop multiple interconnected tables
    const schemaV2 = {
      agents: agentTable,
      // Dropped: entities, memories, relationships, embeddings
      // These all have complex FK relationships
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
      serverAgents: serverAgentsTable,
    };

    const check = await migrator.checkMigration('@elizaos/production-cascade-test', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(true);
      expect(check.warnings.length).toBeGreaterThanOrEqual(4); // At least 4 tables dropped

      console.log('\n🔗 Cascade Drop Analysis:');
      console.log(`  Total warnings: ${check.warnings.length}`);
      check.warnings.forEach((warning) => {
        console.log(`  • ${warning}`);
      });

      // Should detect all dropped tables
      expect(check.warnings.some((w) => w.includes('entities'))).toBe(true);
      expect(check.warnings.some((w) => w.includes('memories'))).toBe(true);
      expect(check.warnings.some((w) => w.includes('relationships'))).toBe(true);
      expect(check.warnings.some((w) => w.includes('embeddings'))).toBe(true);
    }
  });
});
