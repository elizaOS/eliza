import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseMigrationService } from '../migration-service';

describe('Simple SQL Debug Test', () => {
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

  test('should create table with columns and show SQL', async () => {
    // Import the actual agent table to test with real Drizzle schema
    const { agentTable } = await import('../schema/agent');
    
    // Use real Drizzle table structure
    const simpleSchema = {
      agentTable: agentTable,
    };

    const plugins = [{ name: 'debug-test', schema: simpleSchema }];
    service.discoverAndRegisterPluginSchemas(plugins as any);

    // This should show us the actual SQL being generated
    await service.runAllPluginMigrations();

    // Check what was actually created
    const tables = await db.execute(sql.raw(`
      SELECT table_name, table_schema
      FROM information_schema.tables 
      WHERE table_schema = 'debug_test'
    `));
    
    console.log('Created tables:', tables.rows);

    if (tables.rows.length > 0) {
      const tableName = (tables.rows[0] as any).table_name;
      const columns = await db.execute(sql.raw(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_schema = 'debug_test' AND table_name = '${tableName}'
        ORDER BY ordinal_position
      `));
      
      console.log(`Columns in ${tableName} table:`, columns.rows);
    }
  });
});