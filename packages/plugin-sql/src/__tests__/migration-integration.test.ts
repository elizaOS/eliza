import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseIntrospector } from '../database-introspector';
import { SchemaDiffEngine } from '../schema-diff-engine';
import { MigrationPlanner } from '../migration-planner';
import { MigrationExecutor } from '../migration-executor';
import { MigrationHistoryManager } from '../migration-history';
import { EnhancedMigrationService } from '../enhanced-migration-service';
import { DrizzleSchemaIntrospector } from '../custom-migrator';
import type { TableDefinition } from '../custom-migrator';

describe.skip('Migration Integration Tests - TODO: Fix mock schemas', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    // Create in-memory PGLite database for testing
    client = new PGlite();
    db = drizzle(client);

    // Install vector extension if available
    try {
      await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'));
    } catch (error) {
      console.warn('Vector extension not available in test environment');
    }
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    // Clean up any existing test tables before each test
    try {
      const tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'test_%'
      `));
      
      for (const table of tables.rows as any[]) {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS "public"."${table.table_name}" CASCADE`));
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('DatabaseIntrospector Integration', () => {
    test('should introspect real table with all column types', async () => {
      // Create a test table with various column types
      await db.execute(sql.raw(`
        CREATE TABLE test_types (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          description TEXT,
          age INTEGER,
          price DECIMAL(10,2),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          metadata JSONB DEFAULT '{}',
          tags TEXT[]
        )
      `));

      const introspector = new DatabaseIntrospector(db);
      const table = await introspector.introspectTable('public', 'test_types');

      expect(table.name).toBe('test_types');
      expect(table.columns).toHaveLength(9);
      
      const idColumn = table.columns.find(c => c.name === 'id');
      expect(idColumn?.type).toBe('UUID');
      expect(idColumn?.isPrimaryKey).toBe(true);
      expect(idColumn?.nullable).toBe(false);
      expect(idColumn?.defaultValue).toContain('gen_random_uuid');

      const nameColumn = table.columns.find(c => c.name === 'name');
      expect(nameColumn?.type).toBe('VARCHAR(255)');
      expect(nameColumn?.nullable).toBe(false);

      const isActiveColumn = table.columns.find(c => c.name === 'is_active');
      expect(isActiveColumn?.type).toBe('BOOLEAN');
      expect(isActiveColumn?.defaultValue).toContain('true');
    });

    test('should introspect table with indexes and constraints', async () => {
      await db.execute(sql.raw(`
        CREATE TABLE test_constraints (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          age INTEGER CHECK (age >= 0),
          user_id INTEGER,
          CONSTRAINT unique_email_age UNIQUE (email, age)
        )
      `));

      await db.execute(sql.raw(`
        CREATE INDEX idx_test_constraints_user_id ON test_constraints (user_id)
      `));

      const introspector = new DatabaseIntrospector(db);
      const table = await introspector.introspectTable('public', 'test_constraints');

      expect(table.indexes.length).toBeGreaterThan(0);
      
      // Should find unique constraints
      const uniqueIndexes = table.indexes.filter(idx => idx.unique);
      expect(uniqueIndexes.length).toBeGreaterThan(0);

      // Should find check constraints
      expect(table.checkConstraints.length).toBeGreaterThan(0);
      const ageCheck = table.checkConstraints.find(cc => cc.expression.includes('age'));
      expect(ageCheck).toBeDefined();
    });

    test('should introspect foreign key relationships', async () => {
      // Create parent table
      await db.execute(sql.raw(`
        CREATE TABLE test_parent (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL
        )
      `));

      // Create child table with foreign key
      await db.execute(sql.raw(`
        CREATE TABLE test_child (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER NOT NULL,
          value TEXT,
          FOREIGN KEY (parent_id) REFERENCES test_parent(id) ON DELETE CASCADE
        )
      `));

      const introspector = new DatabaseIntrospector(db);
      const childTable = await introspector.introspectTable('public', 'test_child');

      expect(childTable.foreignKeys.length).toBe(1);
      const fk = childTable.foreignKeys[0];
      expect(fk.columns).toContain('parent_id');
      expect(fk.referencedTable).toBe('test_parent');
      expect(fk.referencedColumns).toContain('id');
      expect(fk.onDelete).toBe('CASCADE');
    });

    test('should introspect composite primary keys', async () => {
      await db.execute(sql.raw(`
        CREATE TABLE test_composite (
          tenant_id UUID NOT NULL,
          user_id UUID NOT NULL,
          role VARCHAR(50) NOT NULL,
          PRIMARY KEY (tenant_id, user_id)
        )
      `));

      const introspector = new DatabaseIntrospector(db);
      const table = await introspector.introspectTable('public', 'test_composite');

      expect(table.primaryKey).toBeDefined();
      expect(table.primaryKey!.columns).toHaveLength(2);
      expect(table.primaryKey!.columns).toContain('tenant_id');
      expect(table.primaryKey!.columns).toContain('user_id');
    });
  });

  describe('Schema Diff and Migration Planning', () => {
    test('should detect and plan table creation', async () => {
      const desired = new Map<string, TableDefinition>();
      desired.set('new_users', {
        name: 'new_users',
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true, notNull: true, defaultValue: 'gen_random_uuid()' },
          { name: 'email', type: 'VARCHAR(255)', notNull: true, unique: true },
          { name: 'name', type: 'VARCHAR(255)', notNull: true },
          { name: 'created_at', type: 'TIMESTAMP WITH TIME ZONE', notNull: true, defaultValue: 'now()' },
        ],
        indexes: [
          { name: 'idx_users_email', columns: ['email'], unique: true },
        ],
        foreignKeys: [],
        checkConstraints: [],
        dependencies: [],
      });

      const introspector = new DatabaseIntrospector(db);
      const current = await introspector.introspectSchema('public');

      const diffEngine = new SchemaDiffEngine();
      const diff = await diffEngine.computeDiff(desired, current);

      expect(diff.tablesToCreate).toHaveLength(1);
      expect(diff.tablesToCreate[0].name).toBe('new_users');

      const planner = new MigrationPlanner();
      const plan = await planner.createPlan(diff);

      expect(plan.operations.length).toBeGreaterThan(0);
      expect(plan.operations.some(op => op.type === 'CREATE_TABLE')).toBe(true);
    });

    test('should detect and plan column alterations', async () => {
      // Create initial table
      await db.execute(sql.raw(`
        CREATE TABLE test_evolution (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(100) NOT NULL,
          age INTEGER
        )
      `));

      // Define evolved schema
      const desired = new Map<string, TableDefinition>();
      desired.set('test_evolution', {
        name: 'test_evolution',
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true, notNull: true, defaultValue: 'gen_random_uuid()' },
          { name: 'name', type: 'VARCHAR(255)', notNull: true }, // Changed length
          { name: 'age', type: 'INTEGER', notNull: false },
          { name: 'email', type: 'VARCHAR(255)', notNull: false }, // New column
          { name: 'status', type: 'VARCHAR(50)', notNull: true, defaultValue: "'active'" }, // New column with default
        ],
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        dependencies: [],
      });

      const introspector = new DatabaseIntrospector(db);
      const current = await introspector.introspectSchema('public');

      const diffEngine = new SchemaDiffEngine();
      const diff = await diffEngine.computeDiff(desired, current);

      expect(diff.tablesToAlter).toHaveLength(1);
      const alteration = diff.tablesToAlter[0];
      expect(alteration.columnsToAdd.length).toBeGreaterThan(0);
      expect(alteration.columnsToModify.length).toBeGreaterThan(0);

      const planner = new MigrationPlanner();
      const plan = await planner.createPlan(diff);

      expect(plan.operations.some(op => op.type === 'ALTER_TABLE')).toBe(true);
    });
  });

  describe('Migration Execution', () => {
    test('should execute table creation successfully', async () => {
      const plan = {
        operations: [
          {
            type: 'CREATE_TABLE' as const,
            sql: `CREATE TABLE "public"."test_execution" (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              name VARCHAR(255) NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`,
            isDestructive: false,
            tableName: 'test_execution',
            description: 'Create table test_execution',
          },
        ],
        warnings: [],
        requiresConfirmation: false,
        estimatedDuration: 5,
        backupRecommended: false,
      };

      const executor = new MigrationExecutor(db);
      const result = await executor.executePlan(plan, { force: true });

      expect(result.success).toBe(true);
      expect(result.executedOperations).toHaveLength(1);
      expect(result.failedOperations).toHaveLength(0);

      // Verify table was created
      const tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'test_execution'
      `));
      expect(tables.rows).toHaveLength(1);
    });

    test('should execute column addition successfully', async () => {
      // Create initial table
      await db.execute(sql.raw(`
        CREATE TABLE test_alter (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL
        )
      `));

      const plan = {
        operations: [
          {
            type: 'ALTER_TABLE' as const,
            sql: 'ALTER TABLE "public"."test_alter" ADD COLUMN "email" VARCHAR(255)',
            isDestructive: false,
            tableName: 'test_alter',
            description: 'Add column email',
          },
        ],
        warnings: [],
        requiresConfirmation: false,
        estimatedDuration: 3,
        backupRecommended: false,
      };

      const executor = new MigrationExecutor(db);
      const result = await executor.executePlan(plan, { force: true });

      expect(result.success).toBe(true);

      // Verify column was added
      const columns = await db.execute(sql.raw(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'test_alter'
      `));
      const columnNames = (columns.rows as any[]).map(r => r.column_name);
      expect(columnNames).toContain('email');
    });

    test('should handle execution failures gracefully', async () => {
      const plan = {
        operations: [
          {
            type: 'ALTER_TABLE' as const,
            sql: 'ALTER TABLE "public"."nonexistent_table" ADD COLUMN "test" VARCHAR(255)',
            isDestructive: false,
            tableName: 'nonexistent_table',
            description: 'Add column to nonexistent table',
          },
        ],
        warnings: [],
        requiresConfirmation: false,
        estimatedDuration: 3,
        backupRecommended: false,
      };

      const executor = new MigrationExecutor(db);
      const result = await executor.executePlan(plan, { force: true });

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
      expect(result.failedOperations[0].error).toContain('does not exist');
    });
  });

  describe('Migration History', () => {
    test('should track migration history', async () => {
      const historyManager = new MigrationHistoryManager(db);
      await historyManager.initialize();

      const mockResult = {
        success: true,
        executedOperations: [
          {
            operation: {
              type: 'CREATE_TABLE' as const,
              sql: 'CREATE TABLE test_history (...)',
              isDestructive: false,
              tableName: 'test_history',
              description: 'Create test table',
            },
            executionTime: 100,
          },
        ],
        failedOperations: [],
        duration: 100,
      };

      const migrationId = await historyManager.recordMigration(
        'test-plugin',
        mockResult,
        mockResult.executedOperations.map(op => op.operation)
      );

      expect(migrationId).toBeDefined();

      // Verify history was recorded
      const history = await historyManager.getPluginHistory('test-plugin');
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(migrationId);
      expect(history[0].success).toBe(true);
    });

    test('should support rollback operations', async () => {
      const historyManager = new MigrationHistoryManager(db);
      await historyManager.initialize();

      // Create a table to rollback
      await db.execute(sql.raw(`
        CREATE TABLE test_rollback (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL
        )
      `));

      const mockResult = {
        success: true,
        executedOperations: [
          {
            operation: {
              type: 'CREATE_TABLE' as const,
              sql: 'CREATE TABLE "public"."test_rollback" (...)',
              isDestructive: false,
              tableName: 'test_rollback',
              description: 'Create test_rollback table',
            },
            executionTime: 100,
          },
        ],
        failedOperations: [],
        duration: 100,
      };

      const migrationId = await historyManager.recordMigration(
        'rollback-test-plugin',
        mockResult,
        mockResult.executedOperations.map(op => op.operation)
      );

      // Attempt rollback
      const rollbackSuccess = await historyManager.rollbackMigration(migrationId);
      expect(rollbackSuccess).toBe(true);

      // Verify table was dropped
      const tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'test_rollback'
      `));
      expect(tables.rows).toHaveLength(0);
    });

    test('should provide migration statistics', async () => {
      const historyManager = new MigrationHistoryManager(db);
      await historyManager.initialize();

      // Record a few migrations
      const mockResults = [
        { success: true, executedOperations: [], failedOperations: [], duration: 100 },
        { success: false, executedOperations: [], failedOperations: [], duration: 50 },
        { success: true, executedOperations: [], failedOperations: [], duration: 200 },
      ];

      for (const [index, result] of mockResults.entries()) {
        await historyManager.recordMigration(`test-plugin-${index}`, result, []);
      }

      const stats = await historyManager.getStatistics();
      expect(stats.totalMigrations).toBeGreaterThanOrEqual(3);
      expect(stats.successfulMigrations).toBeGreaterThanOrEqual(2);
      expect(stats.failedMigrations).toBeGreaterThanOrEqual(1);
      expect(stats.averageExecutionTime).toBeGreaterThan(0);
    });
  });

  describe('Enhanced Migration Service Integration', () => {
    test('should handle complete plugin migration workflow', async () => {
      const service = new EnhancedMigrationService();
      await service.initializeWithDatabase(db);

      // Define a realistic plugin schema
      const plugins = [
        {
          name: 'user-management-plugin',
          schema: {
            usersTable: {
              _: { name: 'users' },
              columns: {
                id: { dataType: 'uuid', primary: true, notNull: true },
                email: { dataType: 'text', notNull: true, unique: true },
                name: { dataType: 'text', notNull: true },
                password_hash: { dataType: 'text', notNull: true },
                created_at: { dataType: 'timestamptz', notNull: true },
                updated_at: { dataType: 'timestamptz', notNull: true },
              },
            },
            profilesTable: {
              _: { name: 'profiles' },
              columns: {
                id: { dataType: 'uuid', primary: true, notNull: true },
                user_id: { dataType: 'uuid', notNull: true },
                bio: { dataType: 'text' },
                avatar_url: { dataType: 'text' },
                created_at: { dataType: 'timestamptz', notNull: true },
              },
            },
          },
        },
      ];

      service.discoverAndRegisterPluginSchemas(plugins as any);

      // Run initial migration
      const summaries = await service.runAllPluginMigrations({
        enableAlterOperations: true,
        force: true,
        recordHistory: true,
      });

      expect(summaries).toHaveLength(1);
      expect(summaries[0].success).toBe(true);
      expect(summaries[0].migrationId).toBeDefined();

      // Verify tables were created
      const tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('users', 'profiles')
      `));
      expect(tables.rows).toHaveLength(2);

      // Test schema evolution - add a new column
      const evolvedPlugins = [
        {
          name: 'user-management-plugin',
          schema: {
            usersTable: {
              _: { name: 'users' },
              columns: {
                id: { dataType: 'uuid', primary: true, notNull: true },
                email: { dataType: 'text', notNull: true, unique: true },
                name: { dataType: 'text', notNull: true },
                password_hash: { dataType: 'text', notNull: true },
                phone: { dataType: 'text' }, // New column
                is_verified: { dataType: 'boolean', notNull: true, defaultValue: 'false' }, // New column with default
                created_at: { dataType: 'timestamptz', notNull: true },
                updated_at: { dataType: 'timestamptz', notNull: true },
              },
            },
            profilesTable: {
              _: { name: 'profiles' },
              columns: {
                id: { dataType: 'uuid', primary: true, notNull: true },
                user_id: { dataType: 'uuid', notNull: true },
                bio: { dataType: 'text' },
                avatar_url: { dataType: 'text' },
                created_at: { dataType: 'timestamptz', notNull: true },
              },
            },
          },
        },
      ];

      service.discoverAndRegisterPluginSchemas(evolvedPlugins as any);

      // Run evolution migration
      const evolutionSummaries = await service.runAllPluginMigrations({
        enableAlterOperations: true,
        force: true,
        recordHistory: true,
      });

      expect(evolutionSummaries[0].success).toBe(true);

      // Verify new columns were added
      const userColumns = await db.execute(sql.raw(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'users'
      `));
      const columnNames = (userColumns.rows as any[]).map(r => r.column_name);
      expect(columnNames).toContain('phone');
      expect(columnNames).toContain('is_verified');

      // Test migration history
      const history = await service.getPluginMigrationHistory('user-management-plugin');
      expect(history.length).toBeGreaterThanOrEqual(1);

      // Test statistics
      const stats = await service.getMigrationStatistics();
      expect(stats.totalMigrations).toBeGreaterThanOrEqual(1);
    });

    test('should handle dry run correctly', async () => {
      const service = new EnhancedMigrationService();
      await service.initializeWithDatabase(db);

      const plugins = [
        {
          name: 'dry-run-test-plugin',
          schema: {
            testTable: {
              _: { name: 'dry_run_test' },
              columns: {
                id: { dataType: 'uuid', primary: true },
                name: { dataType: 'text', notNull: true },
              },
            },
          },
        },
      ];

      service.discoverAndRegisterPluginSchemas(plugins as any);

      // Run dry run
      const summaries = await service.dryRunMigrations();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].success).toBe(true);

      // Verify no tables were actually created
      const tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'dry_run_test'
      `));
      expect(tables.rows).toHaveLength(0);
    });

    test('should handle rollback scenarios', async () => {
      const service = new EnhancedMigrationService();
      await service.initializeWithDatabase(db);

      // Create a table that we'll migrate and then rollback
      const plugins = [
        {
          name: 'rollback-test-plugin',
          schema: {
            rollbackTestTable: {
              _: { name: 'rollback_test_table' },
              columns: {
                id: { dataType: 'uuid', primary: true },
                data: { dataType: 'text' },
              },
            },
          },
        },
      ];

      service.discoverAndRegisterPluginSchemas(plugins as any);

      // Run migration
      const summaries = await service.runAllPluginMigrations({
        enableAlterOperations: true,
        force: true,
        recordHistory: true,
      });

      expect(summaries[0].success).toBe(true);
      const migrationId = summaries[0].migrationId!;

      // Verify table exists
      let tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'rollback_test_table'
      `));
      expect(tables.rows).toHaveLength(1);

      // Rollback the migration
      const rollbackSuccess = await service.rollbackMigration(migrationId);
      expect(rollbackSuccess).toBe(true);

      // Verify table was dropped
      tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'rollback_test_table'
      `));
      expect(tables.rows).toHaveLength(0);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle invalid SQL gracefully', async () => {
      const plan = {
        operations: [
          {
            type: 'ALTER_TABLE' as const,
            sql: 'INVALID SQL STATEMENT',
            isDestructive: false,
            tableName: 'test_table',
            description: 'Invalid operation',
          },
        ],
        warnings: [],
        requiresConfirmation: false,
        estimatedDuration: 1,
        backupRecommended: false,
      };

      const executor = new MigrationExecutor(db);
      const result = await executor.executePlan(plan, { force: true });

      expect(result.success).toBe(false);
      expect(result.failedOperations).toHaveLength(1);
      expect(result.failedOperations[0].error).toBeDefined();
    });

    test('should handle complex schema relationships', async () => {
      // Create multiple related tables to test dependency handling
      const service = new EnhancedMigrationService();
      await service.initializeWithDatabase(db);

      const plugins = [
        {
          name: 'complex-schema-plugin',
          schema: {
            organizationsTable: {
              _: { name: 'organizations' },
              columns: {
                id: { dataType: 'uuid', primary: true },
                name: { dataType: 'text', notNull: true },
              },
            },
            usersTable: {
              _: { name: 'users_complex' },
              columns: {
                id: { dataType: 'uuid', primary: true },
                org_id: { dataType: 'uuid', notNull: true },
                email: { dataType: 'text', notNull: true },
              },
            },
            projectsTable: {
              _: { name: 'projects' },
              columns: {
                id: { dataType: 'uuid', primary: true },
                org_id: { dataType: 'uuid', notNull: true },
                owner_id: { dataType: 'uuid', notNull: true },
                name: { dataType: 'text', notNull: true },
              },
            },
          },
        },
      ];

      service.discoverAndRegisterPluginSchemas(plugins as any);

      const summaries = await service.runAllPluginMigrations({
        enableAlterOperations: true,
        force: true,
      });

      expect(summaries[0].success).toBe(true);

      // Verify all tables were created
      const tables = await db.execute(sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('organizations', 'users_complex', 'projects')
      `));
      expect(tables.rows).toHaveLength(3);
    });
  });
});