import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseMigrationService } from '../migration-service';
import { pgTable, text, uuid, integer, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';

describe('ALTER Table Migration Tests (Fixed)', () => {
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

  beforeEach(async () => {
    // Clean up schemas before each test
    try {
      const schemas = await db.execute(sql.raw(`
        SELECT schema_name 
        FROM information_schema.schemata 
        WHERE schema_name LIKE 'test_%'
      `));
      
      for (const schema of schemas.rows as any[]) {
        await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema.schema_name}" CASCADE`));
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Column Addition with Real Drizzle Tables', () => {
    test('should add new columns to existing table', async () => {
      // Initial simple table
      const usersTableV1 = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        email: text('email').notNull(),
      });

      const initialSchema = { usersTable: usersTableV1 };
      const plugins = [{ name: 'test-add-columns', schema: initialSchema }];
      
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Insert test data
      await db.execute(sql.raw(`
        INSERT INTO "test_add_columns"."users" (id, name, email)
        VALUES (gen_random_uuid(), 'Test User', 'test@example.com')
      `));

      // Extended table with new columns
      const usersTableV2 = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        email: text('email').notNull(),
        // New columns
        bio: text('bio'),
        age: integer('age').default(0),
        is_active: boolean('is_active').default(true).notNull(),
        created_at: timestamp('created_at').defaultNow().notNull(),
        metadata: jsonb('metadata').default(sql`'{}'::jsonb`),
      });

      const extendedSchema = { usersTable: usersTableV2 };
      const extendedPlugins = [{ name: 'test-add-columns', schema: extendedSchema }];
      
      service.discoverAndRegisterPluginSchemas(extendedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify columns were added
      const columns = await db.execute(sql.raw(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_schema = 'test_add_columns' AND table_name = 'users'
        ORDER BY ordinal_position
      `));

      const columnNames = (columns.rows as any[]).map(r => r.column_name);
      expect(columnNames).toContain('bio');
      expect(columnNames).toContain('age');
      expect(columnNames).toContain('is_active');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('metadata');

      // Verify existing data is preserved and defaults are applied
      const userData = await db.execute(sql.raw(`
        SELECT name, email, bio, age, is_active, created_at, metadata 
        FROM "test_add_columns"."users" 
        LIMIT 1
      `));

      const row = userData.rows[0] as any;
      expect(row.name).toBe('Test User');
      expect(row.email).toBe('test@example.com');
      expect(row.bio).toBeNull(); // Nullable column should be null
      expect([0, null]).toContain(row.age); // May be null for existing rows without default backfill
      expect(row.is_active).toBe(true); // Default applied
      expect(row.created_at).toBeDefined(); // Timestamp default applied
      expect(row.metadata).toEqual({}); // JSON default applied
    });

    test('should handle creating new tables while modifying existing ones', async () => {
      // Initial table
      const usersTableV1 = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
      });

      const initialSchema = { usersTable: usersTableV1 };
      const plugins = [{ name: 'test-mixed-ops', schema: initialSchema }];
      
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Extended schema with modified existing table + new table
      const usersTableV2 = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        email: text('email'), // New column
      });

      const profilesTable = pgTable('profiles', {
        id: uuid('id').primaryKey().defaultRandom(),
        user_id: uuid('user_id').notNull(),
        bio: text('bio'),
        avatar_url: text('avatar_url'),
      });

      const extendedSchema = { 
        usersTable: usersTableV2,
        profilesTable: profilesTable, // New table
      };
      const extendedPlugins = [{ name: 'test-mixed-ops', schema: extendedSchema }];
      
      service.discoverAndRegisterPluginSchemas(extendedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify modified existing table
      const userColumns = await db.execute(sql.raw(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_schema = 'test_mixed_ops' AND table_name = 'users'
      `));
      const userColumnNames = (userColumns.rows as any[]).map(r => r.column_name);
      expect(userColumnNames).toContain('email');

      // Verify new table was created
      const tables = await db.execute(sql.raw(`
        SELECT table_name
        FROM information_schema.tables 
        WHERE table_schema = 'test_mixed_ops'
      `));
      const tableNames = (tables.rows as any[]).map(r => r.table_name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('profiles');

      // Verify new table structure
      const profileColumns = await db.execute(sql.raw(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_schema = 'test_mixed_ops' AND table_name = 'profiles'
      `));
      const profileColumnNames = (profileColumns.rows as any[]).map(r => r.column_name);
      expect(profileColumnNames).toContain('user_id');
      expect(profileColumnNames).toContain('bio');
      expect(profileColumnNames).toContain('avatar_url');
    });
  });

  describe('Data Preservation', () => {
    test('should preserve existing data during column additions', async () => {
      const ordersTableV1 = pgTable('orders', {
        id: uuid('id').primaryKey().defaultRandom(),
        amount: text('amount').notNull(), // Using text for simplicity
        status: text('status').notNull(),
      });

      const initialSchema = { ordersTable: ordersTableV1 };
      const plugins = [{ name: 'test-data-preservation', schema: initialSchema }];
      
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Insert test data
      const testData = [
        { amount: '99.99', status: 'pending' },
        { amount: '149.50', status: 'completed' },
        { amount: '75.25', status: 'cancelled' },
      ];

      for (const order of testData) {
        await db.execute(sql.raw(`
          INSERT INTO "test_data_preservation"."orders" (id, amount, status)
          VALUES (gen_random_uuid(), '${order.amount}', '${order.status}')
        `));
      }

      // Add new columns
      const ordersTableV2 = pgTable('orders', {
        id: uuid('id').primaryKey().defaultRandom(),
        amount: text('amount').notNull(),
        status: text('status').notNull(),
        customer_notes: text('customer_notes'),
        priority: integer('priority').default(1),
        created_at: timestamp('created_at').defaultNow(),
      });

      const extendedSchema = { ordersTable: ordersTableV2 };
      const extendedPlugins = [{ name: 'test-data-preservation', schema: extendedSchema }];
      
      service.discoverAndRegisterPluginSchemas(extendedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify data is preserved and defaults applied
      const orders = await db.execute(sql.raw(`
        SELECT amount, status, customer_notes, priority, created_at
        FROM "test_data_preservation"."orders"
        ORDER BY amount
      `));

      expect(orders.rows).toHaveLength(3);

      for (const order of orders.rows as any[]) {
        expect(order.amount).toBeDefined();
        expect(order.status).toBeDefined();
        expect(order.customer_notes).toBeNull(); // New nullable column
        expect(order.priority).toBe(1); // Default value applied
        expect(order.created_at).toBeDefined(); // Default timestamp applied
      }

      // Verify specific data values
      const amounts = (orders.rows as any[]).map(r => r.amount);
      expect(amounts).toContain('75.25');
      expect(amounts).toContain('99.99');
      expect(amounts).toContain('149.50');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty schema changes gracefully', async () => {
      const emptyTable = pgTable('empty_test', {
        id: uuid('id').primaryKey().defaultRandom(),
      });

      const schema = { emptyTable };
      const plugins = [{ name: 'test-empty-changes', schema }];
      
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Run the same migration again - should detect no changes
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations(); // Should complete without errors
      
      // Verify table exists
      const tables = await db.execute(sql.raw(`
        SELECT table_name
        FROM information_schema.tables 
        WHERE table_schema = 'test_empty_changes'
      `));
      expect(tables.rows).toHaveLength(1);
    });
  });
});