import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as originalSchema from '../../schema';
import { RuntimeMigrator } from '../../runtime-migrator';
import type { DrizzleDatabase } from '../../types';

const { Client } = pg;

describe('Runtime Migrator - Initialization Tests', () => {
  let db: DrizzleDatabase;
  let client: pg.Client;
  let migrator: RuntimeMigrator;

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5555/eliza2';

  beforeAll(async () => {
    console.log('\n🚀 Testing Runtime Migrator Initialization...\n');

    client = new Client({ connectionString: POSTGRES_URL });
    await client.connect();
    db = drizzle(client, { schema: originalSchema }) as unknown as DrizzleDatabase;

    // Clean slate
    try {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS migrations CASCADE`));
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS public CASCADE`));
      await db.execute(sql.raw(`CREATE SCHEMA public`));
    } catch (error) {
      console.warn('Cleanup warning:', error);
    }

    migrator = new RuntimeMigrator(db);
  });

  afterAll(async () => {
    await client.end();
  });

  describe('Migration Infrastructure Setup', () => {
    it('should initialize migration schema and tables', async () => {
      await migrator.initialize();

      // Check migrations schema exists
      const schemaResult = await db.execute(
        sql.raw(`SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata 
          WHERE schema_name = 'migrations'
        )`)
      );

      expect(schemaResult.rows[0]?.exists).toBe(true);
    });

    it('should create all required migration tables', async () => {
      const expectedTables = ['_migrations', '_journal', '_snapshots'];

      for (const tableName of expectedTables) {
        const result = await db.execute(
          sql.raw(`SELECT EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = 'migrations'
            AND tablename = '${tableName}'
          )`)
        );

        expect(result.rows[0]?.exists).toBe(true);
      }
    });

    it('should create migration tables with correct structure', async () => {
      // Check _migrations table structure
      const migrationsColumns = await db.execute(
        sql.raw(`SELECT column_name, data_type, is_nullable
                 FROM information_schema.columns
                 WHERE table_schema = 'migrations'
                 AND table_name = '_migrations'
                 ORDER BY ordinal_position`)
      );

      const columnNames = migrationsColumns.rows.map((r: any) => r.column_name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('plugin_name');
      expect(columnNames).toContain('hash');
      expect(columnNames).toContain('created_at');

      // Check _journal table structure
      const journalColumns = await db.execute(
        sql.raw(`SELECT column_name, data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'migrations'
                 AND table_name = '_journal'`)
      );

      const journalColumnNames = journalColumns.rows.map((r: any) => r.column_name);
      expect(journalColumnNames).toContain('plugin_name');
      expect(journalColumnNames).toContain('entries');

      // Check _snapshots table structure
      const snapshotColumns = await db.execute(
        sql.raw(`SELECT column_name, data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'migrations'
                 AND table_name = '_snapshots'`)
      );

      const snapshotColumnNames = snapshotColumns.rows.map((r: any) => r.column_name);
      expect(snapshotColumnNames).toContain('plugin_name');
      expect(snapshotColumnNames).toContain('snapshot');
      expect(snapshotColumnNames).toContain('idx');
    });
  });

  describe('Basic Migration Execution', () => {
    it('should run initial schema migration successfully', async () => {
      await migrator.migrate('@elizaos/plugin-sql', originalSchema, { verbose: true });

      // Verify tables were created
      const tablesResult = await db.execute(
        sql.raw(`SELECT tablename FROM pg_tables 
                 WHERE schemaname = 'public' 
                 ORDER BY tablename`)
      );

      const createdTables = tablesResult.rows.map((r: any) => r.tablename);

      const expectedTables = [
        'agents',
        'cache',
        'channel_participants',
        'channels',
        'components',
        'embeddings',
        'entities',
        'logs',
        'memories',
        'message_servers',
        'central_messages',
        'participants',
        'relationships',
        'rooms',
        'server_agents',
        'tasks',
        'worlds',
      ];

      for (const table of expectedTables) {
        expect(createdTables).toContain(table);
      }
    });

    it('should track migration in _migrations table', async () => {
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
      expect(migration.created_at).toBeDefined();
    });

    it('should save journal entry with migration details', async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._journal 
                 WHERE plugin_name = '@elizaos/plugin-sql'`)
      );

      expect(result.rows.length).toBe(1);

      const journal = result.rows[0] as any;
      expect(journal.entries).toBeDefined();
      expect(Array.isArray(journal.entries)).toBe(true);
      expect(journal.entries.length).toBeGreaterThan(0);
    });

    it('should save schema snapshot', async () => {
      const result = await db.execute(
        sql.raw(`SELECT * FROM migrations._snapshots 
                 WHERE plugin_name = '@elizaos/plugin-sql'
                 ORDER BY idx DESC`)
      );

      expect(result.rows.length).toBeGreaterThan(0);

      const snapshot = result.rows[0] as any;
      expect(snapshot.snapshot).toBeDefined();
      expect(snapshot.snapshot.tables).toBeDefined();
      expect(Object.keys(snapshot.snapshot.tables).length).toBeGreaterThan(0);
    });
  });

  describe('Migration Status and Tracking', () => {
    it('should provide accurate migration status', async () => {
      const status = await migrator.getStatus('@elizaos/plugin-sql');

      expect(status.hasRun).toBe(true);
      expect(status.snapshots).toBeGreaterThan(0);
      expect(status.lastMigration).toBeDefined();
    });

    it('should handle status check for non-existent plugin', async () => {
      const status = await migrator.getStatus('non-existent-plugin');

      expect(status.hasRun).toBe(false);
      expect(status.snapshots).toBe(0);
      expect(status.lastMigration).toBeNull();
    });
  });
});
