import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseMigrationService } from '../migration-service';

describe.skip('ALTER Table Migration Tests - TODO: Fix mock schemas', () => {
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

  describe('Column Addition', () => {
    test('should add new columns with defaults', async () => {
      // Initial schema
      const initialSchema = {
        usersTable: {
          _: { name: 'users' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            email: { dataType: 'text', notNull: true, unique: true },
            name: { dataType: 'text', notNull: true },
          },
        },
      };

      const plugins = [{ name: 'test-add-columns', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Insert some test data
      await db.execute(sql.raw(`
        INSERT INTO "test_add_columns"."users" (id, email, name)
        VALUES (gen_random_uuid(), 'test@example.com', 'Test User')
      `));

      // Extended schema with new columns
      const extendedSchema = {
        usersTable: {
          _: { name: 'users' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            email: { dataType: 'text', notNull: true, unique: true },
            name: { dataType: 'text', notNull: true },
            bio: { dataType: 'text' }, // Nullable column
            age: { dataType: 'integer', defaultValue: '0' }, // With default
            is_active: { dataType: 'boolean', notNull: true, defaultValue: 'true' }, // NOT NULL with default
            created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' }, // Timestamp with default
            metadata: { dataType: 'jsonb', defaultValue: "'{}'" }, // JSON with default
          },
        },
      };

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
        SELECT bio, age, is_active, created_at, metadata 
        FROM "test_add_columns"."users" 
        LIMIT 1
      `));

      const row = userData.rows[0] as any;
      expect(row.bio).toBeNull(); // Nullable column should be null
      expect(row.age).toBe(0); // Default applied
      expect(row.is_active).toBe(true); // Default applied
      expect(row.created_at).toBeDefined(); // Timestamp default applied
      expect(row.metadata).toEqual({}); // JSON default applied
    });

    test('should add columns with different data types', async () => {
      const initialSchema = {
        productsTable: {
          _: { name: 'products' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            name: { dataType: 'text', notNull: true },
          },
        },
      };

      const plugins = [{ name: 'test-data-types', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Add columns with various data types
      const extendedSchema = {
        productsTable: {
          _: { name: 'products' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            name: { dataType: 'text', notNull: true },
            price: { dataType: 'decimal', defaultValue: '0.00' },
            quantity: { dataType: 'integer', defaultValue: '0' },
            is_available: { dataType: 'boolean', defaultValue: 'false' },
            tags: { dataType: 'text[]', defaultValue: "'{}'" },
            description: { dataType: 'text' },
            rating: { dataType: 'real', defaultValue: '0.0' },
            created_at: { dataType: 'timestamptz', defaultValue: 'now()' },
            updated_at: { dataType: 'timestamptz', defaultValue: 'now()' },
          },
        },
      };

      const extendedPlugins = [{ name: 'test-data-types', schema: extendedSchema }];
      service.discoverAndRegisterPluginSchemas(extendedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify all data types were added correctly
      const columns = await db.execute(sql.raw(`
        SELECT column_name, data_type
        FROM information_schema.columns 
        WHERE table_schema = 'test_data_types' AND table_name = 'products'
        ORDER BY ordinal_position
      `));

      const columnTypes = Object.fromEntries(
        (columns.rows as any[]).map(r => [r.column_name, r.data_type])
      );

      expect(columnTypes.price).toMatch(/numeric|decimal/);
      expect(columnTypes.quantity).toBe('integer');
      expect(columnTypes.is_available).toBe('boolean');
      expect(columnTypes.tags).toBe('ARRAY');
      expect(columnTypes.description).toBe('text');
      expect(columnTypes.rating).toBe('real');
      expect(columnTypes.created_at).toMatch(/timestamp/);
      expect(columnTypes.updated_at).toMatch(/timestamp/);
    });
  });

  describe('Column Modification', () => {
    test('should modify column nullability', async () => {
      // Create table with nullable column
      const initialSchema = {
        settingsTable: {
          _: { name: 'settings' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            key: { dataType: 'text', notNull: true },
            value: { dataType: 'text' }, // Nullable
          },
        },
      };

      const plugins = [{ name: 'test-nullability', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Insert test data with null value
      await db.execute(sql.raw(`
        INSERT INTO "test_nullability"."settings" (id, key, value)
        VALUES (gen_random_uuid(), 'test_key', NULL)
      `));

      // Modify to make column NOT NULL with default
      const modifiedSchema = {
        settingsTable: {
          _: { name: 'settings' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            key: { dataType: 'text', notNull: true },
            value: { dataType: 'text', notNull: true, defaultValue: "'default_value'" }, // Now NOT NULL
          },
        },
      };

      const modifiedPlugins = [{ name: 'test-nullability', schema: modifiedSchema }];
      service.discoverAndRegisterPluginSchemas(modifiedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify nullability changed
      const columns = await db.execute(sql.raw(`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_schema = 'test_nullability' AND table_name = 'settings' AND column_name = 'value'
      `));

      const valueColumn = columns.rows[0] as any;
      expect(valueColumn.is_nullable).toBe('NO');
      expect(valueColumn.column_default).toContain('default_value');
    });

    test('should modify column default values', async () => {
      const initialSchema = {
        configTable: {
          _: { name: 'config' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            enabled: { dataType: 'boolean', defaultValue: 'false' },
            timeout: { dataType: 'integer', defaultValue: '30' },
          },
        },
      };

      const plugins = [{ name: 'test-defaults', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Modify default values
      const modifiedSchema = {
        configTable: {
          _: { name: 'config' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            enabled: { dataType: 'boolean', defaultValue: 'true' }, // Changed default
            timeout: { dataType: 'integer', defaultValue: '60' }, // Changed default
          },
        },
      };

      const modifiedPlugins = [{ name: 'test-defaults', schema: modifiedSchema }];
      service.discoverAndRegisterPluginSchemas(modifiedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify defaults changed
      const columns = await db.execute(sql.raw(`
        SELECT column_name, column_default
        FROM information_schema.columns 
        WHERE table_schema = 'test_defaults' AND table_name = 'config'
        AND column_name IN ('enabled', 'timeout')
        ORDER BY column_name
      `));

      const defaults = Object.fromEntries(
        (columns.rows as any[]).map(r => [r.column_name, r.column_default])
      );

      expect(defaults.enabled).toContain('true');
      expect(defaults.timeout).toContain('60');
    });
  });

  describe('Multiple Table Operations', () => {
    test('should handle adding columns to multiple tables', async () => {
      const initialSchema = {
        usersTable: {
          _: { name: 'users' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            name: { dataType: 'text', notNull: true },
          },
        },
        postsTable: {
          _: { name: 'posts' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            title: { dataType: 'text', notNull: true },
          },
        },
      };

      const plugins = [{ name: 'test-multi-tables', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Add columns to both tables
      const extendedSchema = {
        usersTable: {
          _: { name: 'users' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            name: { dataType: 'text', notNull: true },
            email: { dataType: 'text', unique: true }, // New column
            created_at: { dataType: 'timestamptz', defaultValue: 'now()' }, // New column
          },
        },
        postsTable: {
          _: { name: 'posts' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            title: { dataType: 'text', notNull: true },
            content: { dataType: 'text' }, // New column
            user_id: { dataType: 'uuid' }, // New column
            published: { dataType: 'boolean', defaultValue: 'false' }, // New column
          },
        },
      };

      const extendedPlugins = [{ name: 'test-multi-tables', schema: extendedSchema }];
      service.discoverAndRegisterPluginSchemas(extendedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify users table
      const userColumns = await db.execute(sql.raw(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_schema = 'test_multi_tables' AND table_name = 'users'
      `));
      const userColumnNames = (userColumns.rows as any[]).map(r => r.column_name);
      expect(userColumnNames).toContain('email');
      expect(userColumnNames).toContain('created_at');

      // Verify posts table
      const postColumns = await db.execute(sql.raw(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_schema = 'test_multi_tables' AND table_name = 'posts'
      `));
      const postColumnNames = (postColumns.rows as any[]).map(r => r.column_name);
      expect(postColumnNames).toContain('content');
      expect(postColumnNames).toContain('user_id');
      expect(postColumnNames).toContain('published');
    });

    test('should handle creating new tables while modifying existing ones', async () => {
      const initialSchema = {
        usersTable: {
          _: { name: 'users' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            name: { dataType: 'text', notNull: true },
          },
        },
      };

      const plugins = [{ name: 'test-mixed-ops', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Add new table and modify existing table
      const extendedSchema = {
        usersTable: {
          _: { name: 'users' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            name: { dataType: 'text', notNull: true },
            email: { dataType: 'text' }, // New column
          },
        },
        profilesTable: { // New table
          _: { name: 'profiles' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            user_id: { dataType: 'uuid', notNull: true },
            bio: { dataType: 'text' },
            avatar_url: { dataType: 'text' },
          },
        },
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
      const initialSchema = {
        ordersTable: {
          _: { name: 'orders' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            amount: { dataType: 'decimal', notNull: true },
            status: { dataType: 'text', notNull: true },
          },
        },
      };

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
          VALUES (gen_random_uuid(), ${order.amount}, '${order.status}')
        `));
      }

      // Add new columns
      const extendedSchema = {
        ordersTable: {
          _: { name: 'orders' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            amount: { dataType: 'decimal', notNull: true },
            status: { dataType: 'text', notNull: true },
            customer_notes: { dataType: 'text' },
            priority: { dataType: 'integer', defaultValue: '1' },
            created_at: { dataType: 'timestamptz', defaultValue: 'now()' },
          },
        },
      };

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
      const amounts = (orders.rows as any[]).map(r => parseFloat(r.amount));
      expect(amounts).toContain(75.25);
      expect(amounts).toContain(99.99);
      expect(amounts).toContain(149.50);
    });

    test('should handle complex data types during migration', async () => {
      const initialSchema = {
        documentsTable: {
          _: { name: 'documents' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            title: { dataType: 'text', notNull: true },
          },
        },
      };

      const plugins = [{ name: 'test-complex-types', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Insert test data
      await db.execute(sql.raw(`
        INSERT INTO "test_complex_types"."documents" (id, title)
        VALUES (gen_random_uuid(), 'Test Document')
      `));

      // Add complex data type columns
      const extendedSchema = {
        documentsTable: {
          _: { name: 'documents' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            title: { dataType: 'text', notNull: true },
            metadata: { dataType: 'jsonb', defaultValue: "'{}'" },
            tags: { dataType: 'text[]', defaultValue: "'{}'" },
            content: { dataType: 'text' },
            version: { dataType: 'integer', defaultValue: '1' },
          },
        },
      };

      const extendedPlugins = [{ name: 'test-complex-types', schema: extendedSchema }];
      service.discoverAndRegisterPluginSchemas(extendedPlugins as any);
      await service.runAllPluginMigrations();

      // Verify complex types work
      const documents = await db.execute(sql.raw(`
        SELECT title, metadata, tags, content, version
        FROM "test_complex_types"."documents"
        LIMIT 1
      `));

      const doc = documents.rows[0] as any;
      expect(doc.title).toBe('Test Document');
      expect(doc.metadata).toEqual({});
      expect(doc.tags).toEqual([]);
      expect(doc.content).toBeNull();
      expect(doc.version).toBe(1);

      // Test inserting data with complex types
      await db.execute(sql.raw(`
        UPDATE "test_complex_types"."documents" 
        SET metadata = '{"author": "test", "category": "documentation"}',
            tags = ARRAY['test', 'documentation'],
            content = 'This is test content'
        WHERE title = 'Test Document'
      `));

      const updatedDoc = await db.execute(sql.raw(`
        SELECT metadata, tags, content
        FROM "test_complex_types"."documents"
        WHERE title = 'Test Document'
      `));

      const updated = updatedDoc.rows[0] as any;
      expect(updated.metadata.author).toBe('test');
      expect(updated.tags).toContain('test');
      expect(updated.content).toBe('This is test content');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle empty schema changes gracefully', async () => {
      const schema = {
        emptyTable: {
          _: { name: 'empty_test' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
          },
        },
      };

      const plugins = [{ name: 'test-empty-changes', schema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Run the same migration again - should detect no changes
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations(); // Should complete without errors
    });

    test('should handle rapid successive schema changes', async () => {
      let currentSchema = {
        rapidTable: {
          _: { name: 'rapid_changes' },
          columns: {
            id: { dataType: 'uuid', primaryKey: true, notNull: true },
            step: { dataType: 'integer', defaultValue: '1' },
          },
        },
      };

      // Initial creation
      let plugins = [{ name: 'test-rapid-changes', schema: currentSchema }];
      service.discoverAndRegisterPluginSchemas(plugins as any);
      await service.runAllPluginMigrations();

      // Multiple rapid changes
      for (let i = 2; i <= 5; i++) {
        currentSchema.rapidTable.columns[`field_${i}`] = { 
          dataType: 'text', 
          defaultValue: `'step_${i}'` 
        };
        currentSchema.rapidTable.columns.step.defaultValue = `'${i}'`;

        plugins = [{ name: 'test-rapid-changes', schema: currentSchema }];
        service.discoverAndRegisterPluginSchemas(plugins as any);
        await service.runAllPluginMigrations();
      }

      // Verify final state
      const columns = await db.execute(sql.raw(`
        SELECT column_name
        FROM information_schema.columns 
        WHERE table_schema = 'test_rapid_changes' AND table_name = 'rapid_changes'
      `));

      const columnNames = (columns.rows as any[]).map(r => r.column_name);
      expect(columnNames).toContain('field_2');
      expect(columnNames).toContain('field_3');
      expect(columnNames).toContain('field_4');
      expect(columnNames).toContain('field_5');
    });
  });
});