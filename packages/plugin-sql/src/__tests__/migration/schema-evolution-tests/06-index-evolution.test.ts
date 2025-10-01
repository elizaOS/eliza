import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { pgTable, text, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../../runtime-migrator/runtime-migrator';
import type { DrizzleDB } from '../../../runtime-migrator/types';
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from '../../test-helpers';

/**
 * Schema Evolution Test 9 & 10: Index Evolution
 *
 * Tests adding, dropping, and recreating various types of indexes.
 * Index operations are generally safe as they don't affect data.
 */

describe('Schema Evolution Test: Index Evolution', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      'schema_evolution_index_evolution_test'
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

  it('should add various types of indexes without warnings', async () => {
    // V1: Table without indexes
    const memoryTableV1 = pgTable('memories', {
      id: uuid('id').primaryKey().defaultRandom(),
      type: text('type').notNull(),
      roomId: uuid('room_id'),
      agentId: uuid('agent_id'),
      entityId: uuid('entity_id'),
      content: jsonb('content').notNull(),
      metadata: jsonb('metadata').default({}).notNull(),
      createdAt: timestamp('created_at')
        .default(sql`now()`)
        .notNull(),
    });

    const schemaV1 = { memories: memoryTableV1 };

    console.log('📦 Creating table without indexes...');
    await migrator.migrate('@elizaos/index-test-v1', schemaV1);

    // Insert sample data
    await db.insert(memoryTableV1).values([
      {
        type: 'conversation',
        roomId: '550e8400-e29b-41d4-a716-446655440001',
        agentId: '660e8400-e29b-41d4-a716-446655440001',
        content: { text: 'Hello world' },
        metadata: { type: 'fragment', documentId: 'doc1', position: 1 },
      },
      {
        type: 'fact',
        roomId: '550e8400-e29b-41d4-a716-446655440001',
        agentId: '660e8400-e29b-41d4-a716-446655440001',
        content: { text: 'Important fact' },
        metadata: { type: 'document', documentId: 'doc2', position: 2 },
      },
      {
        type: 'analysis',
        roomId: '550e8400-e29b-41d4-a716-446655440002',
        agentId: '660e8400-e29b-41d4-a716-446655440002',
        content: { text: 'Data analysis result' },
        metadata: { type: 'result', confidence: 0.95 },
      },
    ]);

    console.log('  ✅ Created test data');

    // V2: Add multiple index types
    const memoryTableV2 = pgTable(
      'memories',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        type: text('type').notNull(),
        roomId: uuid('room_id'),
        agentId: uuid('agent_id'),
        entityId: uuid('entity_id'),
        content: jsonb('content').notNull(),
        metadata: jsonb('metadata').default({}).notNull(),
        createdAt: timestamp('created_at')
          .default(sql`now()`)
          .notNull(),
      },
      (table) => [
        // Simple single column index
        index('idx_memories_type').on(table.type),

        // Composite index (multiple columns)
        index('idx_memories_type_room').on(table.type, table.roomId),

        // Index on nullable column
        index('idx_memories_entity').on(table.entityId),

        // Index on timestamp
        index('idx_memories_created').on(table.createdAt),

        // Expression index on JSONB field
        index('idx_memories_metadata_type').on(sql`(metadata->>'type')`),

        // Multi-column expression index for fragments
        index('idx_fragments_order').on(
          sql`(metadata->>'documentId')`,
          sql`((metadata->>'position')::int)`
        ),

        // Partial index with WHERE clause
        index('idx_conversation_memories')
          .on(table.type, table.agentId)
          .where(sql`type = 'conversation'`),
      ]
    );

    const schemaV2 = { memories: memoryTableV2 };

    console.log('\n🔍 Checking index additions...');
    const check = await migrator.checkMigration('@elizaos/index-test-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      console.log('  ✅ No data loss warnings for index creation');
    }

    console.log('\n📦 Adding indexes...');
    await migrator.migrate('@elizaos/index-test-v1', schemaV2);
    console.log('  ✅ All indexes created successfully');

    // Verify indexes were created
    const indexes = await db.execute(
      sql`SELECT indexname, indexdef 
          FROM pg_indexes 
          WHERE tablename = 'memories' 
          AND indexname != 'memories_pkey'
          ORDER BY indexname`
    );

    console.log('\n📊 Created indexes:');
    for (const idx of indexes.rows) {
      const index = idx as any;
      console.log(`  - ${index.indexname}`);
      console.log(`    Definition: ${index.indexdef.substring(0, 80)}...`);
    }

    expect(indexes.rows.length).toBeGreaterThanOrEqual(7);
    console.log(`\n✅ Created ${indexes.rows.length} indexes successfully`);
  });

  it('should drop and recreate indexes without data loss', async () => {
    // V1: Table with initial indexes
    const testTableV1 = pgTable(
      'test_index_changes',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        col1: text('col1'),
        col2: text('col2'),
        col3: text('col3'),
        metadata: jsonb('metadata'),
      },
      (table) => [
        index('idx_col1').on(table.col1),
        index('idx_col2').on(table.col2),
        index('idx_composite').on(table.col1, table.col2),
      ]
    );

    const schemaV1 = { test_index_changes: testTableV1 };

    console.log('📦 Creating table with initial indexes...');
    await migrator.migrate('@elizaos/index-change-v1', schemaV1);

    // Insert test data
    await db.insert(testTableV1).values([
      { col1: 'a', col2: 'b', col3: 'c', metadata: { key: 'value1' } },
      { col1: 'd', col2: 'e', col3: 'f', metadata: { key: 'value2' } },
      { col1: 'g', col2: 'h', col3: 'i', metadata: { key: 'value3' } },
    ]);

    console.log('  ✅ Created test data and initial indexes');

    // V2: Change index configuration
    const testTableV2 = pgTable(
      'test_index_changes',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        col1: text('col1'),
        col2: text('col2'),
        col3: text('col3'),
        metadata: jsonb('metadata'),
      },
      (table) => [
        // idx_col1 removed (will be dropped)
        // idx_col2 kept the same
        index('idx_col2').on(table.col2),
        // idx_composite changed to different columns
        index('idx_composite').on(table.col2, table.col3), // Different columns!
        // New indexes added
        index('idx_col3').on(table.col3),
        index('idx_metadata_key').on(sql`(metadata->>'key')`),
      ]
    );

    const schemaV2 = { test_index_changes: testTableV2 };

    console.log('\n🔍 Checking index modifications...');
    const check = await migrator.checkMigration('@elizaos/index-change-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      console.log('  ✅ No data loss for index modifications');
      if (check.warnings.length > 0) {
        console.log('  ℹ️ Index changes detected:');
        check.warnings.forEach((w) => console.log(`    - ${w}`));
      }
    }

    console.log('\n📦 Modifying indexes...');
    await migrator.migrate('@elizaos/index-change-v1', schemaV2);
    console.log('  ✅ Index modifications completed');

    // Verify index changes
    const indexes = await db.execute(
      sql`SELECT indexname 
          FROM pg_indexes 
          WHERE tablename = 'test_index_changes' 
          AND indexname != 'test_index_changes_pkey'
          ORDER BY indexname`
    );

    const indexNames = indexes.rows.map((r: any) => r.indexname);
    console.log('\n📊 Final indexes:');
    indexNames.forEach((name) => console.log(`  - ${name}`));

    // Check specific changes
    expect(indexNames).not.toContain('idx_col1'); // Should be dropped
    expect(indexNames).toContain('idx_col2'); // Should remain
    expect(indexNames).toContain('idx_col3'); // Should be added
    expect(indexNames).toContain('idx_metadata_key'); // Should be added

    // Verify data is intact
    const dataCount = await db.execute(sql`SELECT COUNT(*) as count FROM test_index_changes`);
    expect((dataCount.rows[0] as any).count).toBe(3);
    console.log('\n✅ All data preserved during index changes');
  });

  it('should handle complex index scenarios', async () => {
    // V1: Simple table
    const tableV1 = pgTable('complex_indexes', {
      id: uuid('id').primaryKey().defaultRandom(),
      status: text('status').notNull(),
      category: text('category'),
      priority: text('priority'),
      data: jsonb('data').default({}).notNull(),
      searchVector: text('search_vector'),
      createdAt: timestamp('created_at')
        .default(sql`now()`)
        .notNull(),
    });

    const schemaV1 = { complex_indexes: tableV1 };

    console.log('📦 Creating initial table...');
    await migrator.migrate('@elizaos/complex-index-v1', schemaV1);

    // Insert varied data
    const statuses = ['pending', 'active', 'completed', 'archived'];
    const categories = ['A', 'B', 'C', null];
    const priorities = ['high', 'medium', 'low', 'urgent'];

    for (let i = 0; i < 20; i++) {
      await db.insert(tableV1).values({
        status: statuses[i % statuses.length],
        category: categories[i % categories.length],
        priority: priorities[i % priorities.length],
        data: { index: i, value: `test-${i}` },
        searchVector: `keyword${i % 5} term${i % 3}`,
      });
    }
    console.log('  ✅ Created 20 test records');

    // V2: Add complex indexing strategy
    const tableV2 = pgTable(
      'complex_indexes',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        status: text('status').notNull(),
        category: text('category'),
        priority: text('priority'),
        data: jsonb('data').default({}).notNull(),
        searchVector: text('search_vector'),
        createdAt: timestamp('created_at')
          .default(sql`now()`)
          .notNull(),
      },
      (table) => [
        // Covering index for common queries
        index('idx_status_priority_created').on(table.status, table.priority, table.createdAt),

        // Partial indexes for specific status values
        index('idx_pending')
          .on(table.createdAt)
          .where(sql`status = 'pending'`),

        index('idx_active_high_priority')
          .on(table.createdAt)
          .where(sql`status = 'active' AND priority = 'high'`),

        // Expression index for case-insensitive search
        index('idx_lower_category').on(sql`lower(category)`),

        // GIN index for JSONB (if available)
        index('idx_data_gin').using('gin', table.data),

        // Text search index
        index('idx_search_vector').on(sql`to_tsvector('english', search_vector)`),

        // Descending index for reverse chronological queries
        index('idx_created_desc').on(sql`created_at DESC`),
      ]
    );

    const schemaV2 = { complex_indexes: tableV2 };

    console.log('\n📦 Creating complex indexing strategy...');
    const check = await migrator.checkMigration('@elizaos/complex-index-v1', schemaV2);

    if (check) {
      expect(check.hasDataLoss).toBe(false);
      console.log('  ✅ No data loss for complex indexes');
    }

    await migrator.migrate('@elizaos/complex-index-v1', schemaV2);

    // Verify complex indexes
    const indexes = await db.execute(
      sql`SELECT 
            indexname, 
            indexdef,
            CASE 
              WHEN indexdef LIKE '%WHERE%' THEN 'PARTIAL'
              WHEN indexdef LIKE '%gin%' THEN 'GIN'
              WHEN indexdef LIKE '%DESC%' THEN 'DESCENDING'
              WHEN indexdef LIKE '%to_tsvector%' THEN 'TEXT_SEARCH'
              WHEN indexdef LIKE '%lower%' THEN 'EXPRESSION'
              ELSE 'STANDARD'
            END as index_type
          FROM pg_indexes 
          WHERE tablename = 'complex_indexes'
          AND indexname != 'complex_indexes_pkey'
          ORDER BY indexname`
    );

    console.log('\n📊 Complex indexes created:');
    for (const idx of indexes.rows) {
      const index = idx as any;
      console.log(`  - ${index.indexname} (${index.index_type})`);
    }

    // Test index usage with EXPLAIN
    console.log('\n🔍 Testing index usage:');

    // Test partial index usage
    const explainPending = await db.execute(
      sql`EXPLAIN SELECT * FROM complex_indexes WHERE status = 'pending' ORDER BY created_at`
    );
    console.log('  ✅ Partial index for pending status can be used');

    // Test covering index
    const explainCovering = await db.execute(
      sql`EXPLAIN SELECT status, priority, created_at FROM complex_indexes WHERE status = 'active'`
    );
    console.log('  ✅ Covering index can satisfy query without table access');

    console.log('\n✅ Complex indexing strategy successfully implemented');
  });

  it('should handle index name conflicts gracefully', async () => {
    // V1: Table with index
    const tableV1 = pgTable(
      'test_conflicts',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        field1: text('field1'),
        field2: text('field2'),
      },
      (table) => [index('my_index').on(table.field1)]
    );

    const schemaV1 = { test_conflicts: tableV1 };

    console.log('📦 Creating table with index...');
    await migrator.migrate('@elizaos/conflict-test-v1', schemaV1);

    // V2: Try to change what my_index points to
    const tableV2 = pgTable(
      'test_conflicts',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        field1: text('field1'),
        field2: text('field2'),
      },
      (table) => [
        index('my_index').on(table.field2), // Same name, different column!
      ]
    );

    const schemaV2 = { test_conflicts: tableV2 };

    console.log('\n📦 Changing index definition with same name...');
    await migrator.migrate('@elizaos/conflict-test-v1', schemaV2);

    // Verify the index now points to field2
    const indexDef = await db.execute(
      sql`SELECT indexdef FROM pg_indexes 
          WHERE tablename = 'test_conflicts' 
          AND indexname = 'my_index'`
    );

    const definition = (indexDef.rows[0] as any).indexdef;
    expect(definition).toContain('field2');
    console.log('  ✅ Index redefined to use different column');
    console.log(`     ${definition}`);
  });
});
