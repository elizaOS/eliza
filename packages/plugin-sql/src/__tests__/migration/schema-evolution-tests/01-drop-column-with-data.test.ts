import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../../runtime-migrator/runtime-migrator';
import type { DrizzleDB } from '../../../runtime-migrator/types';
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from '../../test-helpers';

// Import the ACTUAL production schemas
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
 * Schema Evolution Test 1: Dropping Columns from Production Schema
 *
 * This test uses the ACTUAL ElizaOS production schemas to verify
 * that schema evolution properly handles column drops with real data.
 */

describe('Schema Evolution Test: Drop Column with Production Schema', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  // Full production schema as it exists today
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
      'schema_evolution_drop_column_test'
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

  it('should handle dropping username column from agents table with production data', async () => {
    // Apply the full production schema
    const schemaV1 = getFullSchemaV1();

    console.log('🚀 Migrating full production schema V1...');
    await migrator.migrate('@elizaos/production-schema-v1', schemaV1);

    // Insert production-like data into multiple related tables
    console.log('\n📝 Inserting production data...');

    // Insert agents with username field
    await db.insert(agentTable).values([
      {
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'Agent Alpha',
        username: 'alpha_bot', // This field will be dropped
        bio: ['Expert in natural language processing', 'Specialized in customer support'],
        enabled: true,
        system: 'You are a helpful assistant',
        messageExamples: [],
        postExamples: [],
        topics: ['technology', 'support'],
        adjectives: ['helpful', 'knowledgeable'],
        knowledge: [],
        plugins: ['bootstrap', 'sql'],
        settings: { secrets: {} },
        style: { all: ['professional', 'friendly'] },
      },
      {
        id: '550e8400-e29b-41d4-a716-446655440002',
        name: 'Agent Beta',
        username: 'beta_bot', // This field will be dropped
        bio: ['Data analysis specialist'],
        enabled: true,
        system: 'You are a data analyst',
        messageExamples: [],
        postExamples: [],
        topics: ['data', 'analytics'],
        adjectives: ['analytical', 'precise'],
        knowledge: [],
        plugins: ['bootstrap'],
        settings: {},
        style: {},
      },
    ]);

    // Insert related entities
    await db.insert(entityTable).values([
      {
        id: '660e8400-e29b-41d4-a716-446655440001',
        agentId: '550e8400-e29b-41d4-a716-446655440001',
        names: ['User One'],
        metadata: { role: 'admin', type: 'user' },
      },
      {
        id: '660e8400-e29b-41d4-a716-446655440002',
        agentId: '550e8400-e29b-41d4-a716-446655440002',
        names: ['User Two'],
        metadata: { role: 'member', type: 'user' },
      },
    ]);

    // Insert memories linked to agents
    await db.insert(memoryTable).values([
      {
        id: '770e8400-e29b-41d4-a716-446655440001',
        agentId: '550e8400-e29b-41d4-a716-446655440001',
        entityId: '660e8400-e29b-41d4-a716-446655440001',
        type: 'conversation',
        content: { text: 'Important customer interaction', sentiment: 'positive' },
        metadata: { type: 'fragment', documentId: 'doc1', position: 1 },
        unique: true,
      },
      {
        id: '770e8400-e29b-41d4-a716-446655440002',
        agentId: '550e8400-e29b-41d4-a716-446655440002',
        entityId: '660e8400-e29b-41d4-a716-446655440002',
        type: 'fact',
        content: { data: 'Analysis result', confidence: 0.95 },
        metadata: { type: 'document', timestamp: new Date().toISOString() },
        unique: true,
      },
    ]);

    // Verify data was inserted
    const agentsBeforeCount = await db.execute(sql`SELECT COUNT(*) as count FROM agents`);
    const memoriesBeforeCount = await db.execute(sql`SELECT COUNT(*) as count FROM memories`);

    console.log('\n📊 Production data statistics:');
    console.log(`  - Agents: ${(agentsBeforeCount.rows[0] as any).count}`);
    console.log(`  - Memories: ${(memoriesBeforeCount.rows[0] as any).count}`);

    // Check usernames exist
    const usernameCheck = await db.execute(
      sql`SELECT name, username FROM agents WHERE username IS NOT NULL`
    );
    console.log(`  - Agents with usernames: ${usernameCheck.rows.length}`);
    usernameCheck.rows.forEach((row: any) => {
      console.log(`    • ${row.name}: @${row.username}`);
    });

    // Now create V2 schema WITHOUT username column (destructive change!)
    // We need to recreate the agent table definition without username
    const { pgTable, text, uuid, boolean, timestamp, jsonb, unique } = await import(
      'drizzle-orm/pg-core'
    );

    const agentTableV2 = pgTable(
      'agents',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        enabled: boolean('enabled').default(true).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
          .default(sql`now()`)
          .notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
          .default(sql`now()`)
          .notNull(),
        name: text('name').notNull(),
        // username: text('username'), // REMOVED - destructive change!
        system: text('system').default(''),
        bio: jsonb('bio')
          .$type<string | string[]>()
          .default(sql`'[]'::jsonb`),
        messageExamples: jsonb('message_examples')
          .default(sql`'[]'::jsonb`)
          .notNull(),
        postExamples: jsonb('post_examples')
          .default(sql`'[]'::jsonb`)
          .notNull(),
        topics: jsonb('topics')
          .default(sql`'[]'::jsonb`)
          .notNull(),
        adjectives: jsonb('adjectives')
          .default(sql`'[]'::jsonb`)
          .notNull(),
        knowledge: jsonb('knowledge')
          .default(sql`'[]'::jsonb`)
          .notNull(),
        plugins: jsonb('plugins')
          .default(sql`'[]'::jsonb`)
          .notNull(),
        settings: jsonb('settings')
          .default(sql`'{}'::jsonb`)
          .notNull(),
        style: jsonb('style')
          .default(sql`'{}'::jsonb`)
          .notNull(),
      },
      (table) => ({
        nameUnique: unique('name_unique').on(table.name),
      })
    );

    const schemaV2 = {
      ...schemaV1,
      agents: agentTableV2, // Replace with version without username
    };

    // Test 1: Check migration for data loss warnings
    console.log('\n🔍 Checking migration for data loss...');
    const dataLossCheck = await migrator.checkMigration('@elizaos/production-schema-v1', schemaV2);

    if (dataLossCheck) {
      expect(dataLossCheck.hasDataLoss).toBe(true);
      expect(dataLossCheck.requiresConfirmation).toBe(true);
      expect(dataLossCheck.warnings).toContain(
        'Column "username" in table "public.agents" will be dropped'
      );

      console.log('\n⚠️  Data Loss Detection:');
      dataLossCheck.warnings.forEach((warning) => {
        console.log(`  ❌ ${warning}`);
      });
    }

    // Test 2: Attempt migration without environment variable (should fail even in development)
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
    expect(blockedError?.message).toContain('ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS');
    console.log(`  ✅ Migration blocked: ${blockedError?.message}`);

    // Test 3: Production mode should also block (even with more warnings)
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
    console.log(`  ✅ Production blocked: ${productionError?.message.substring(0, 80)}...`);

    // Test 4: Allow migration with environment variable
    process.env.NODE_ENV = 'development';
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';

    console.log('\n⚠️  Testing with ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true...');
    await migrator.migrate('@elizaos/production-schema-v1', schemaV2);
    console.log('  ✅ Migration allowed with environment variable');

    // Reset for next test
    await migrator.migrate('@elizaos/production-schema-v1', schemaV1);

    // Test 5: Force migration with options (alternative method)
    delete process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;

    console.log('\n⚠️  Testing with force option...');
    await migrator.migrate('@elizaos/production-schema-v1', schemaV2, {
      force: true,
      allowDataLoss: true,
    });
    console.log('  ✅ Migration allowed with force option');

    // Verify column was dropped
    const columnsAfter = await db.execute(
      sql`SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'agents' AND table_schema = 'public'`
    );

    const columnNames = columnsAfter.rows.map((r: any) => r.column_name);
    expect(columnNames).not.toContain('username');

    console.log('\n📊 Schema after migration:');
    console.log(`  ✅ Agent table columns: ${columnNames.length}`);
    console.log('  ❌ Username column has been dropped');

    // Verify related data is intact
    const agentsAfterCount = await db.execute(sql`SELECT COUNT(*) as count FROM agents`);
    const memoriesAfterCount = await db.execute(sql`SELECT COUNT(*) as count FROM memories`);

    console.log('\n✅ Data integrity check:');
    console.log(`  - Agents preserved: ${(agentsAfterCount.rows[0] as any).count}`);
    console.log(`  - Memories preserved: ${(memoriesAfterCount.rows[0] as any).count}`);
    console.log('  - Username data: PERMANENTLY LOST');
  });
});
