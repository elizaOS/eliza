import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';
import { createIsolatedTestDatabaseForMigration } from '../test-helpers';
import type { UUID } from '@elizaos/core';
import * as coreSchema from '../../schema';
import { testPolymarketSchema } from '../plugin-schema/test-plugin-schema.ts';

describe('Runtime Migrator - Core + Plugin Schema Tests', () => {
  let db: DrizzleDatabase;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    console.log('\n🚀 Testing Runtime Migrator with Core + Plugin Schemas...\n');

    const testSetup = await createIsolatedTestDatabaseForMigration('plugin_schema_tests');
    cleanup = testSetup.cleanup;
    testAgentId = testSetup.testAgentId;
    db = testSetup.db;

    // Create a new migrator for testing
    migrator = new RuntimeMigrator(db);

    // Initialize migration infrastructure
    await migrator.initialize();
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Core Schema Migration', () => {
    it('should migrate core schema to public schema', async () => {
      console.log('\n📦 Migrating core schema (@elizaos/plugin-sql)...\n');

      await migrator.migrate('@elizaos/plugin-sql', coreSchema, {
        verbose: true,
      });

      // Verify core tables were created in public schema
      const tablesResult = await db.execute(
        sql.raw(`SELECT tablename FROM pg_tables 
                 WHERE schemaname = 'public' 
                 ORDER BY tablename`)
      );

      const createdTables = tablesResult.rows.map((r: any) => r.tablename);
      console.log('Core tables created in public schema:', createdTables);

      const expectedCoreTables = [
        'agents',
        'cache',
        'memories',
        'participants',
        'relationships',
        'rooms',
        'tasks',
      ];

      for (const table of expectedCoreTables) {
        expect(createdTables).toContain(table);
      }
    });

    it('should track core migration in _migrations table', async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/plugin-sql'
                 ORDER BY created_at DESC
                 LIMIT 1`)
      );

      expect(result.rows.length).toBeGreaterThan(0);
      const migration = result.rows[0] as any;
      expect(migration.plugin_name).toBe('@elizaos/plugin-sql');
      expect(migration.hash).toBeDefined();
    });
  });

  describe('Plugin Schema Migration', () => {
    it('should migrate plugin schema to polymarket schema namespace', async () => {
      console.log('\n🔌 Migrating polymarket plugin schema...\n');

      await migrator.migrate('polymarket', testPolymarketSchema, {
        verbose: true,
      });

      // Check if polymarket schema was created
      const schemaResult = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata 
          WHERE schema_name = 'polymarket'
        )`)
      );

      expect(schemaResult.rows[0]?.exists).toBe(true);
      console.log('✅ Polymarket schema created');
    });

    it('should create plugin tables in polymarket schema', async () => {
      // Verify plugin tables were created in polymarket schema
      const tablesResult = await db.execute(
        sql.raw(`SELECT tablename FROM pg_tables 
                 WHERE schemaname = 'polymarket' 
                 ORDER BY tablename`)
      );

      const createdTables = tablesResult.rows.map((r: any) => r.tablename);
      console.log('Plugin tables created in polymarket schema:', createdTables);

      const expectedPluginTables = ['markets', 'tokens', 'rewards', 'prices', 'sync_status'];

      for (const table of expectedPluginTables) {
        expect(createdTables).toContain(table);
      }
    });

    it('should verify no plugin tables in public schema', async () => {
      // Ensure plugin tables are NOT in public schema
      const publicTablesResult = await db.execute(
        sql.raw(`SELECT tablename FROM pg_tables 
                 WHERE schemaname = 'public' 
                 AND tablename LIKE 'polymarket_%'`)
      );

      expect(publicTablesResult.rows.length).toBe(0);
      console.log('✅ No polymarket tables in public schema');
    });

    it('should track plugin migration in _migrations table', async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._migrations 
                 WHERE plugin_name = 'polymarket'
                 ORDER BY created_at DESC
                 LIMIT 1`)
      );

      expect(result.rows.length).toBeGreaterThan(0);
      const migration = result.rows[0] as any;
      expect(migration.plugin_name).toBe('polymarket');
      expect(migration.hash).toBeDefined();
    });

    it('should verify foreign key constraints work across tables in polymarket schema', async () => {
      // Check that foreign key constraints were properly created
      const fkResult = await db.execute(
        sql.raw(`
          SELECT 
            tc.constraint_name,
            tc.table_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name
          FROM information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' 
            AND tc.table_schema = 'polymarket'
          ORDER BY tc.table_name, tc.constraint_name
        `)
      );

      const foreignKeys = fkResult.rows;
      console.log(`Found ${foreignKeys.length} foreign keys in polymarket schema`);

      // Verify at least some expected foreign keys exist
      const tokensFk = foreignKeys.find(
        (fk: any) => fk.table_name === 'tokens' && fk.foreign_table_name === 'markets'
      );
      expect(tokensFk).toBeDefined();

      const pricesFk = foreignKeys.find(
        (fk: any) => fk.table_name === 'prices' && fk.foreign_table_name === 'markets'
      );
      expect(pricesFk).toBeDefined();
    });

    it('should create indexes in polymarket schema', async () => {
      // Check that indexes were created
      const indexResult = await db.execute(
        sql.raw(`
          SELECT 
            schemaname,
            tablename,
            indexname
          FROM pg_indexes
          WHERE schemaname = 'polymarket'
          ORDER BY tablename, indexname
        `)
      );

      const indexes = indexResult.rows;
      console.log(`Found ${indexes.length} indexes in polymarket schema`);

      // Verify some expected indexes exist
      const marketIndexes = indexes.filter((idx: any) => idx.tablename === 'markets');
      expect(marketIndexes.length).toBeGreaterThan(0);

      // Check for specific index
      const conditionIdIdx = indexes.find(
        (idx: any) => idx.indexname === 'markets_condition_id_idx'
      );
      expect(conditionIdIdx).toBeDefined();
    });
  });

  describe('Migration Idempotency', () => {
    it('should skip re-migration when schema has not changed', async () => {
      console.log('\n🔄 Testing migration idempotency...\n');

      // Try to migrate core schema again
      const coreResult = await migrator.migrate('@elizaos/plugin-sql', coreSchema, {
        verbose: true,
      });

      // Check logs to verify it was skipped
      const coreMigrations = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = '@elizaos/plugin-sql'`)
      );

      // Should only have 1 migration record
      expect(coreMigrations.rows[0]?.count).toBe(1);

      // Try to migrate plugin schema again
      const pluginResult = await migrator.migrate('polymarket', testPolymarketSchema, {
        verbose: true,
      });

      const pluginMigrations = await db.execute(
        sql.raw(`SELECT COUNT(*) as count FROM migrations._migrations 
                 WHERE plugin_name = 'polymarket'`)
      );

      // Should only have 1 migration record
      expect(pluginMigrations.rows[0]?.count).toBe(1);
    });
  });

  describe('Schema Isolation', () => {
    it('should verify core and plugin schemas are properly isolated', async () => {
      // Get all schemas
      const schemasResult = await db.execute(
        sql.raw(`SELECT schema_name FROM information_schema.schemata 
                 WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                 ORDER BY schema_name`)
      );

      const schemas = schemasResult.rows.map((r: any) => r.schema_name);
      console.log('Available schemas:', schemas);

      expect(schemas).toContain('public');
      expect(schemas).toContain('polymarket');
      expect(schemas).toContain('migrations');
    });

    it('should verify table counts per schema', async () => {
      const tableCountsResult = await db.execute(
        sql.raw(`
          SELECT 
            schemaname,
            COUNT(*) as table_count
          FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          GROUP BY schemaname
          ORDER BY schemaname
        `)
      );

      const counts = tableCountsResult.rows.reduce((acc: any, row: any) => {
        acc[row.schemaname] = parseInt(row.table_count);
        return acc;
      }, {});

      console.log('Table counts per schema:', counts);

      // Core tables in public schema
      expect(counts.public).toBeGreaterThan(10); // Core has many tables

      // Plugin tables in polymarket schema
      expect(counts.polymarket).toBe(5); // markets, tokens, rewards, prices, sync_status

      // Migration tables
      expect(counts.migrations).toBe(3); // _migrations, _journal, _snapshots
    });
  });

  describe('Migration Status', () => {
    it('should provide accurate status for both core and plugin', async () => {
      const coreStatus = await migrator.getStatus('@elizaos/plugin-sql');
      const pluginStatus = await migrator.getStatus('polymarket');

      console.log('\nMigration Status:');
      console.log('Core:', {
        hasRun: coreStatus.hasRun,
        snapshots: coreStatus.snapshots,
      });
      console.log('Plugin:', {
        hasRun: pluginStatus.hasRun,
        snapshots: pluginStatus.snapshots,
      });

      expect(coreStatus.hasRun).toBe(true);
      expect(coreStatus.snapshots).toBeGreaterThan(0);

      expect(pluginStatus.hasRun).toBe(true);
      expect(pluginStatus.snapshots).toBeGreaterThan(0);
    });
  });

  describe('Polymarket Schema Write/Read Operations', () => {
    it('should successfully insert and read data from polymarket.markets table', async () => {
      console.log('\n🔍 Testing write/read operations on polymarket schema...\n');

      const testConditionId = 'test_' + testAgentId.slice(0, 8);
      const testMarketId = testAgentId; // Use the test UUID

      // Direct insert using the polymarket schema tables
      try {
        // Import the actual schema tables
        const { polymarketMarketsTable, polymarketTokensTable, polymarketRewardsTable } =
          await import('../plugin-schema/test-plugin-schema.ts');

        // Test 1: Insert a market
        console.log('Inserting test market...');
        await db.insert(polymarketMarketsTable).values({
          id: testMarketId,
          conditionId: testConditionId,
          questionId: 'test_question_' + Date.now(),
          marketSlug: 'test-market-slug',
          question: 'Test market question?',
          category: 'Test',
          active: true,
          closed: false,
          secondsDelay: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSyncedAt: new Date(),
        });
        console.log('✅ Market inserted successfully');

        // Verify the insert with raw SQL to confirm schema
        const marketCheck = await db.execute(
          sql.raw(`SELECT * FROM polymarket.markets WHERE condition_id = '${testConditionId}'`)
        );
        expect(marketCheck.rows.length).toBe(1);
        expect(marketCheck.rows[0].condition_id).toBe(testConditionId);
        console.log('✅ Market verified via raw SQL');

        // Test 2: Insert tokens for the market
        const tokenId1 = 'token_yes_' + Date.now();
        const tokenId2 = 'token_no_' + Date.now();

        console.log('Inserting test tokens...');
        await db.insert(polymarketTokensTable).values([
          {
            id: sql`gen_random_uuid()`,
            tokenId: tokenId1,
            conditionId: testConditionId,
            outcome: 'YES',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: sql`gen_random_uuid()`,
            tokenId: tokenId2,
            conditionId: testConditionId,
            outcome: 'NO',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
        console.log('✅ Tokens inserted successfully');

        // Verify tokens
        const tokenCheck = await db.execute(
          sql.raw(`SELECT * FROM polymarket.tokens WHERE condition_id = '${testConditionId}'`)
        );
        expect(tokenCheck.rows.length).toBe(2);
        console.log('✅ Tokens verified via raw SQL');

        // Test 3: Insert reward config
        console.log('Inserting test reward config...');
        await db.insert(polymarketRewardsTable).values({
          id: sql`gen_random_uuid()`,
          conditionId: testConditionId,
          minSize: '100',
          maxSpread: '0.05',
          rewardEpoch: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log('✅ Reward config inserted successfully');

        // Test 4: Test ON CONFLICT DO UPDATE (upsert)
        console.log('Testing upsert functionality...');
        await db
          .insert(polymarketMarketsTable)
          .values({
            id: sql`gen_random_uuid()`,
            conditionId: testConditionId,
            questionId: 'updated_question_' + Date.now(),
            marketSlug: 'updated-market-slug',
            question: 'Updated test market question?',
            category: 'Updated',
            active: false,
            closed: true,
            secondsDelay: 5,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSyncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: polymarketMarketsTable.conditionId,
            set: {
              question: 'Updated test market question?',
              active: false,
              closed: true,
              updatedAt: new Date(),
            },
          });
        console.log('✅ Upsert operation completed');

        // Verify the update
        const updatedMarket = await db.execute(
          sql.raw(`SELECT * FROM polymarket.markets WHERE condition_id = '${testConditionId}'`)
        );
        expect(updatedMarket.rows[0].question).toBe('Updated test market question?');
        expect(updatedMarket.rows[0].active).toBe(false);
        expect(updatedMarket.rows[0].closed).toBe(true);
        console.log('✅ Upsert verified');

        // Clean up test data
        console.log('Cleaning up test data...');
        await db.execute(
          sql.raw(`DELETE FROM polymarket.rewards WHERE condition_id = '${testConditionId}'`)
        );
        await db.execute(
          sql.raw(`DELETE FROM polymarket.tokens WHERE condition_id = '${testConditionId}'`)
        );
        await db.execute(
          sql.raw(`DELETE FROM polymarket.markets WHERE condition_id = '${testConditionId}'`)
        );
        console.log('✅ Test data cleaned up');
      } catch (error) {
        console.error('❌ Write/Read test failed:', error);
        if (error instanceof Error) {
          console.error('Error message:', error.message);
          console.error('Stack trace:', error.stack);
        }
        throw error;
      }
    });

    it('should handle foreign key constraints correctly', async () => {
      console.log('\n🔍 Testing foreign key constraints...\n');

      const { polymarketMarketsTable, polymarketTokensTable } = await import(
        '../plugin-schema/test-plugin-schema.ts'
      );

      // Try to insert a token with non-existent conditionId (should fail)
      const invalidConditionId = 'non_existent_' + Date.now();
      const tokenId = 'test_token_' + Date.now();

      try {
        await db.insert(polymarketTokensTable).values({
          id: sql`gen_random_uuid()`,
          tokenId: tokenId,
          conditionId: invalidConditionId,
          outcome: 'YES',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // If we get here, the foreign key constraint didn't work
        throw new Error('Foreign key constraint should have prevented this insert');
      } catch (error: any) {
        // This is expected - foreign key violation
        console.log('✅ Foreign key constraint working correctly');

        // In PGLite, the actual error is in the cause property
        const errorMessage = error.cause?.message || error.message;

        // The error should be a foreign key violation
        const isValidForeignKeyError =
          errorMessage.includes('violates foreign key constraint') ||
          (error.message.includes('Failed query') &&
            error.message.includes('insert into "polymarket"."tokens"') &&
            !error.message.includes('Foreign key constraint should have prevented this insert'));

        expect(isValidForeignKeyError).toBe(true);
      }
    });

    it('should handle transactions correctly across schema boundaries', async () => {
      console.log('\n🔍 Testing transactions with polymarket schema...\n');

      const { polymarketMarketsTable, polymarketTokensTable } = await import(
        '../plugin-schema/test-plugin-schema.ts'
      );

      const testConditionId = 'tx_test_' + Date.now();
      let transactionSucceeded = false;

      try {
        await db.transaction(async (tx: any) => {
          // Insert market
          await tx.insert(polymarketMarketsTable).values({
            id: sql`gen_random_uuid()`,
            conditionId: testConditionId,
            questionId: 'tx_question',
            marketSlug: 'tx-test',
            question: 'Transaction test?',
            active: true,
            closed: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSyncedAt: new Date(),
          });

          // Insert token
          await tx.insert(polymarketTokensTable).values({
            id: sql`gen_random_uuid()`,
            tokenId: 'tx_token_' + Date.now(),
            conditionId: testConditionId,
            outcome: 'YES',
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          transactionSucceeded = true;
          console.log('✅ Transaction operations completed');
        });

        // Verify both inserts succeeded
        const marketResult = await db.execute(
          sql.raw(`SELECT * FROM polymarket.markets WHERE condition_id = '${testConditionId}'`)
        );
        const tokenResult = await db.execute(
          sql.raw(`SELECT * FROM polymarket.tokens WHERE condition_id = '${testConditionId}'`)
        );

        expect(marketResult.rows.length).toBe(1);
        expect(tokenResult.rows.length).toBe(1);
        expect(transactionSucceeded).toBe(true);
        console.log('✅ Transaction committed successfully');

        // Clean up
        await db.execute(
          sql.raw(`DELETE FROM polymarket.tokens WHERE condition_id = '${testConditionId}'`)
        );
        await db.execute(
          sql.raw(`DELETE FROM polymarket.markets WHERE condition_id = '${testConditionId}'`)
        );
      } catch (error) {
        console.error('❌ Transaction test failed:', error);
        throw error;
      }
    });

    it('should correctly use schema-qualified table names in queries', async () => {
      console.log('\n🔍 Testing schema qualification...\n');

      // Test that Drizzle generates correct SQL with schema prefix
      const { polymarketMarketsTable } = await import('../plugin-schema/test-plugin-schema.ts');

      // Use Drizzle's query builder to verify it generates correct SQL
      const query = db
        .select()
        .from(polymarketMarketsTable)
        .where(sql`active = true`)
        .limit(1)
        .toSQL();

      console.log('Generated SQL:', query.sql);

      // Verify the SQL includes the schema qualification
      expect(query.sql).toContain('polymarket');
      expect(query.sql).toMatch(/"polymarket"\."markets"/);
      console.log('✅ Schema qualification verified in generated SQL');
    });
  });
});
