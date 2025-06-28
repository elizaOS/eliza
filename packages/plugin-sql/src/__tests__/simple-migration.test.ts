import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseMigrationService } from '../migration-service';

describe.skip('Simple Migration Test - TODO: Fix mock schemas', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let service: DatabaseMigrationService;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    service = new DatabaseMigrationService();
    await service.initializeWithDatabase(db);
  });

  afterAll(async () => {
    await client.close();
  });

  test('should handle simple table creation without falling back', async () => {
    // Simple schema with just one table
    const simpleSchema = {
      usersTable: {
        _: { name: 'test_users' },
        columns: {
          id: { dataType: 'uuid', primaryKey: true, notNull: true },
          name: { dataType: 'text', notNull: true },
          email: { dataType: 'text', notNull: true, unique: true },
          created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' },
        },
      },
    };

    const plugins = [{ name: 'test-plugin', schema: simpleSchema }];
    service.discoverAndRegisterPluginSchemas(plugins as any);

    // This should work without any fallback
    await service.runAllPluginMigrations();

    // Check what tables were actually created
    const allTables = await db.execute(sql.raw(`
      SELECT table_name, table_schema
      FROM information_schema.tables 
      WHERE table_name LIKE '%test%' OR table_name LIKE '%user%'
    `));
    
    console.log('All test/user tables:', allTables.rows);
    
    // Also check all tables in test-plugin schema
    const testPluginTables = await db.execute(sql.raw(`
      SELECT table_name, table_schema
      FROM information_schema.tables 
      WHERE table_schema LIKE '%test%' OR table_schema LIKE '%plugin%'
    `));
    
    console.log('Test plugin schema tables:', testPluginTables.rows);
    
    // Verify table was created in the correct schema
    const tables = await db.execute(sql.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'test_plugin' AND table_name = 'test_users'
    `));
    
    expect(tables.rows).toHaveLength(1);

    // Check what columns actually exist
    const columns = await db.execute(sql.raw(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'test_plugin' AND table_name = 'test_users'
      ORDER BY ordinal_position
    `));
    
    console.log('Columns in test_users:', columns.rows);
    expect(columns.rows.length).toBeGreaterThan(0);
    
    const columnNames = (columns.rows as any[]).map(r => r.column_name);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('name');
    expect(columnNames).toContain('email');
    expect(columnNames).toContain('created_at');
  });

  test('should add new columns to existing table', async () => {
    // Add a new column to the existing table
    const extendedSchema = {
      usersTable: {
        _: { name: 'test_users' },
        columns: {
          id: { dataType: 'uuid', primaryKey: true, notNull: true },
          name: { dataType: 'text', notNull: true },
          email: { dataType: 'text', notNull: true, unique: true },
          created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' },
          bio: { dataType: 'text' }, // New column
          is_active: { dataType: 'boolean', notNull: true, defaultValue: 'true' }, // New column with default
        },
      },
    };

    const plugins = [{ name: 'test-plugin', schema: extendedSchema }];
    service.discoverAndRegisterPluginSchemas(plugins as any);

    // This should add the new columns
    await service.runAllPluginMigrations();

    // Verify new columns were added
    const columns = await db.execute(sql.raw(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_schema = 'test_plugin' AND table_name = 'test_users'
      ORDER BY ordinal_position
    `));
    
    expect(columns.rows).toHaveLength(6);
    
    const columnNames = (columns.rows as any[]).map(r => r.column_name);
    expect(columnNames).toContain('bio');
    expect(columnNames).toContain('is_active');
  });
});