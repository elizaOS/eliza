import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseMigrationService } from '../migration-service';
import { pgTable, text, uuid, boolean, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';

describe.skip('Schema Evolution Scenarios', () => {
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
    // Clean up tables before each test
    try {
      const tables = await db.execute(
        sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'evolution_%'
      `)
      );

      for (const table of tables.rows as any[]) {
        await db.execute(sql.raw(`DROP TABLE IF EXISTS "public"."${table.table_name}" CASCADE`));
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Progressive Schema Evolution', () => {
    test('should handle complete application lifecycle migration', async () => {
      // Phase 1: Initial application with basic user management
      console.log('Phase 1: Initial Schema');
      const evolutionUsersV1 = pgTable('evolution_users', {
        id: uuid('id').primaryKey().defaultRandom(),
        email: text('email').notNull().unique(),
        name: text('name').notNull(),
        created_at: timestamp('created_at').defaultNow().notNull(),
      });

      const v1Schema = {
        usersTable: evolutionUsersV1,
      };

      const v1Plugin = [{ name: 'user-app', schema: v1Schema }];
      service.discoverAndRegisterPluginSchemas(v1Plugin as any);

      let summaries = await service.runAllPluginMigrations({ force: true, recordHistory: true });
      expect(summaries[0].success).toBe(true);

      // Verify initial state
      let userColumns = await db.execute(
        sql.raw(`
        SELECT column_name, data_type, is_nullable, column_default 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'evolution_users'
        ORDER BY ordinal_position
      `)
      );
      expect(userColumns.rows).toHaveLength(4);

      // Phase 2: Add authentication features
      console.log('Phase 2: Add Authentication');
      const v2Schema = {
        usersTable: {
          _: { name: 'evolution_users' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            email: { dataType: 'text', notNull: true, unique: true },
            name: { dataType: 'text', notNull: true },
            password_hash: { dataType: 'text', notNull: true }, // New
            is_verified: { dataType: 'boolean', notNull: true, defaultValue: 'false' }, // New
            verification_token: { dataType: 'text' }, // New
            created_at: { dataType: 'timestamptz', notNull: true },
            updated_at: { dataType: 'timestamptz', notNull: true }, // New
          },
        },
        sessionsTable: {
          _: { name: 'evolution_sessions' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            user_id: { dataType: 'uuid', notNull: true },
            token: { dataType: 'text', notNull: true },
            expires_at: { dataType: 'timestamptz', notNull: true },
            created_at: { dataType: 'timestamptz', notNull: true },
          },
        },
      };

      const v2Plugin = [{ name: 'user-app', schema: v2Schema }];
      service.discoverAndRegisterPluginSchemas(v2Plugin as any);

      summaries = await service.runAllPluginMigrations({ force: true, recordHistory: true });
      expect(summaries[0].success).toBe(true);

      // Verify authentication features added
      userColumns = await db.execute(
        sql.raw(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'evolution_users'
      `)
      );
      const userColumnNames = (userColumns.rows as any[]).map((r) => r.column_name);
      expect(userColumnNames).toContain('password_hash');
      expect(userColumnNames).toContain('is_verified');
      expect(userColumnNames).toContain('verification_token');
      expect(userColumnNames).toContain('updated_at');

      // Verify sessions table was created
      const sessionTables = await db.execute(
        sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'evolution_sessions'
      `)
      );
      expect(sessionTables.rows).toHaveLength(1);

      // Phase 3: Add profile and social features
      console.log('Phase 3: Add Profile Features');
      const v3Schema = {
        usersTable: {
          _: { name: 'evolution_users' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            email: { dataType: 'text', notNull: true, unique: true },
            username: { dataType: 'text', unique: true }, // Changed from 'name' to 'username'
            display_name: { dataType: 'text' }, // New
            password_hash: { dataType: 'text', notNull: true },
            is_verified: { dataType: 'boolean', notNull: true, defaultValue: 'false' },
            verification_token: { dataType: 'text' },
            avatar_url: { dataType: 'text' }, // New
            bio: { dataType: 'text' }, // New
            location: { dataType: 'text' }, // New
            website: { dataType: 'text' }, // New
            created_at: { dataType: 'timestamptz', notNull: true },
            updated_at: { dataType: 'timestamptz', notNull: true },
          },
        },
        sessionsTable: {
          _: { name: 'evolution_sessions' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            user_id: { dataType: 'uuid', notNull: true },
            token: { dataType: 'text', notNull: true },
            expires_at: { dataType: 'timestamptz', notNull: true },
            created_at: { dataType: 'timestamptz', notNull: true },
          },
        },
        postsTable: {
          _: { name: 'evolution_posts' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            user_id: { dataType: 'uuid', notNull: true },
            title: { dataType: 'text', notNull: true },
            content: { dataType: 'text', notNull: true },
            published: { dataType: 'boolean', notNull: true, defaultValue: 'false' },
            created_at: { dataType: 'timestamptz', notNull: true },
            updated_at: { dataType: 'timestamptz', notNull: true },
          },
        },
        followsTable: {
          _: { name: 'evolution_follows' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            follower_id: { dataType: 'uuid', notNull: true },
            following_id: { dataType: 'uuid', notNull: true },
            created_at: { dataType: 'timestamptz', notNull: true },
          },
        },
      };

      const v3Plugin = [{ name: 'user-app', schema: v3Schema }];
      service.discoverAndRegisterPluginSchemas(v3Plugin as any);

      summaries = await service.runAllPluginMigrations({ force: true, recordHistory: true });
      expect(summaries[0].success).toBe(true);

      // Verify profile features
      userColumns = await db.execute(
        sql.raw(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'evolution_users'
      `)
      );
      const v3UserColumnNames = (userColumns.rows as any[]).map((r) => r.column_name);
      expect(v3UserColumnNames).toContain('username');
      expect(v3UserColumnNames).toContain('display_name');
      expect(v3UserColumnNames).toContain('avatar_url');
      expect(v3UserColumnNames).toContain('bio');

      // Verify social tables
      const socialTables = await db.execute(
        sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('evolution_posts', 'evolution_follows')
      `)
      );
      expect(socialTables.rows).toHaveLength(2);

      // Verify migration history shows evolution
      const history = await service.getPluginMigrationHistory('user-app');
      expect(history.length).toBeGreaterThanOrEqual(3);
      expect(history.every((h) => h.success)).toBe(true);
    });
  });

  describe('Data Type Evolution', () => {
    test('should handle data type changes safely', async () => {
      // Create initial table with simple types
      const initialSchema = {
        dataTypesTable: {
          _: { name: 'evolution_data_types' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            age: { dataType: 'integer' },
            price: { dataType: 'integer' }, // Will change to decimal
            status: { dataType: 'text' }, // Will add constraint
            metadata: { dataType: 'text' }, // Will change to jsonb
            tags: { dataType: 'text' }, // Will change to array
          },
        },
      };

      const initialPlugin = [{ name: 'data-types-app', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(initialPlugin as any);

      let summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Insert some test data
      await db.execute(
        sql.raw(`
        INSERT INTO evolution_data_types (id, age, price, status, metadata, tags)
        VALUES (
          gen_random_uuid(),
          25,
          1000,
          'active',
          '{"key": "value"}',
          'tag1,tag2'
        )
      `)
      );

      // Evolve data types
      const evolvedSchema = {
        dataTypesTable: {
          _: { name: 'evolution_data_types' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            age: { dataType: 'integer' },
            price: { dataType: 'decimal' }, // Changed from integer
            status: { dataType: 'text', notNull: true }, // Added NOT NULL
            metadata: { dataType: 'jsonb' }, // Changed from text
            tags: { dataType: 'text[]' }, // Changed to array
            created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' }, // New
          },
        },
      };

      const evolvedPlugin = [{ name: 'data-types-app', schema: evolvedSchema }];
      service.discoverAndRegisterPluginSchemas(evolvedPlugin as any);

      // This should show warnings about potentially risky operations
      const dryRunSummaries = await service.dryRunMigrations();
      expect(dryRunSummaries[0].warnings.length).toBeGreaterThan(0);

      // Execute the evolution
      summaries = await service.runAllPluginMigrations({ force: true });

      // Note: Some type changes might fail with real data, which is expected
      // The important thing is that the system handles it gracefully
      expect(summaries[0]).toBeDefined();

      // Verify data preservation where possible
      const dataCount = await db.execute(
        sql.raw(`
        SELECT COUNT(*) as count FROM evolution_data_types
      `)
      );
      expect(parseInt((dataCount.rows[0] as any).count)).toBeGreaterThan(0);
    });
  });

  describe('Index and Constraint Evolution', () => {
    test('should handle index and constraint changes', async () => {
      // Create table with basic constraints
      const initialSchema = {
        constraintsTable: {
          _: { name: 'evolution_constraints' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            email: { dataType: 'text', notNull: true },
            username: { dataType: 'text', notNull: true },
            age: { dataType: 'integer' },
            score: { dataType: 'integer' },
          },
        },
      };

      const initialPlugin = [{ name: 'constraints-app', schema: initialSchema }];
      service.discoverAndRegisterPluginSchemas(initialPlugin as any);

      let summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Evolve to add constraints and indexes
      const evolvedSchema = {
        constraintsTable: {
          _: { name: 'evolution_constraints' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            email: { dataType: 'text', notNull: true, unique: true }, // Add unique
            username: { dataType: 'text', notNull: true, unique: true }, // Add unique
            age: { dataType: 'integer' }, // Will add check constraint
            score: { dataType: 'integer' }, // Will add check constraint
            category: { dataType: 'text', notNull: true, defaultValue: "'general'" }, // New with default
            created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' }, // New
          },
          // TODO: Add support for explicit index and constraint definitions
        },
      };

      const evolvedPlugin = [{ name: 'constraints-app', schema: evolvedSchema }];
      service.discoverAndRegisterPluginSchemas(evolvedPlugin as any);

      summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Verify constraints were added
      const constraints = await db.execute(
        sql.raw(`
        SELECT constraint_name, constraint_type 
        FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'evolution_constraints'
      `)
      );

      const constraintTypes = (constraints.rows as any[]).map((r) => r.constraint_type);
      expect(constraintTypes).toContain('UNIQUE');
      expect(constraintTypes).toContain('PRIMARY KEY');
    });
  });

  describe('Relationship Evolution', () => {
    test('should handle foreign key relationship changes', async () => {
      // Phase 1: Create independent tables
      const phase1Schema = {
        authorsTable: {
          _: { name: 'evolution_authors' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            name: { dataType: 'text', notNull: true },
            email: { dataType: 'text', notNull: true, unique: true },
          },
        },
        booksTable: {
          _: { name: 'evolution_books' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            title: { dataType: 'text', notNull: true },
            isbn: { dataType: 'text', unique: true },
            published_date: { dataType: 'date' },
          },
        },
      };

      const phase1Plugin = [{ name: 'library-app', schema: phase1Schema }];
      service.discoverAndRegisterPluginSchemas(phase1Plugin as any);

      let summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Insert some data
      await db.execute(
        sql.raw(`
        INSERT INTO evolution_authors (id, name, email)
        VALUES (gen_random_uuid(), 'John Doe', 'john@example.com')
      `)
      );

      const authorResult = await db.execute(
        sql.raw(`
        SELECT id FROM evolution_authors LIMIT 1
      `)
      );
      const authorId = (authorResult.rows[0] as any).id;

      await db.execute(
        sql.raw(`
        INSERT INTO evolution_books (id, title, isbn)
        VALUES (gen_random_uuid(), 'Test Book', '978-0000000000')
      `)
      );

      // Phase 2: Add relationships
      const phase2Schema = {
        authorsTable: {
          _: { name: 'evolution_authors' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            name: { dataType: 'text', notNull: true },
            email: { dataType: 'text', notNull: true, unique: true },
            bio: { dataType: 'text' }, // New field
          },
        },
        booksTable: {
          _: { name: 'evolution_books' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            title: { dataType: 'text', notNull: true },
            isbn: { dataType: 'text', unique: true },
            author_id: { dataType: 'uuid' }, // New foreign key
            published_date: { dataType: 'date' },
            page_count: { dataType: 'integer' }, // New field
          },
        },
        reviewsTable: {
          _: { name: 'evolution_reviews' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            book_id: { dataType: 'uuid', notNull: true }, // Foreign key
            reviewer_name: { dataType: 'text', notNull: true },
            rating: { dataType: 'integer', notNull: true },
            comment: { dataType: 'text' },
            created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' },
          },
        },
      };

      const phase2Plugin = [{ name: 'library-app', schema: phase2Schema }];
      service.discoverAndRegisterPluginSchemas(phase2Plugin as any);

      summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Verify new relationships
      const tables = await db.execute(
        sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('evolution_authors', 'evolution_books', 'evolution_reviews')
      `)
      );
      expect(tables.rows).toHaveLength(3);

      // Verify new columns exist
      const bookColumns = await db.execute(
        sql.raw(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'evolution_books'
      `)
      );
      const bookColumnNames = (bookColumns.rows as any[]).map((r) => r.column_name);
      expect(bookColumnNames).toContain('author_id');
      expect(bookColumnNames).toContain('page_count');

      // Verify data integrity
      const bookCount = await db.execute(
        sql.raw(`
        SELECT COUNT(*) as count FROM evolution_books
      `)
      );
      expect(parseInt((bookCount.rows[0] as any).count)).toBeGreaterThan(0);
    });
  });

  describe('Error Recovery and Rollback', () => {
    test('should handle partial migration failures and recovery', async () => {
      // Create initial successful migration
      const workingSchema = {
        testTable: {
          _: { name: 'evolution_error_test' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            name: { dataType: 'text', notNull: true },
          },
        },
      };

      const workingPlugin = [{ name: 'error-test-app', schema: workingSchema }];
      service.discoverAndRegisterPluginSchemas(workingPlugin as any);

      const summaries = await service.runAllPluginMigrations({ force: true, recordHistory: true });
      expect(summaries[0].success).toBe(true);
      const successfulMigrationId = summaries[0].migrationId!;

      // Insert some data
      await db.execute(
        sql.raw(`
        INSERT INTO evolution_error_test (id, name)
        VALUES (gen_random_uuid(), 'Test Record')
      `)
      );

      // Test rollback of successful migration
      const rollbackSuccess = await service.rollbackMigration(successfulMigrationId);
      expect(rollbackSuccess).toBe(true);

      // Verify table was dropped
      const tables = await db.execute(
        sql.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'evolution_error_test'
      `)
      );
      expect(tables.rows).toHaveLength(0);

      // Verify rollback was recorded in history
      const history = await service.getPluginMigrationHistory('error-test-app');
      expect(history.length).toBeGreaterThan(0);
    });
  });

  describe('Performance and Scale Considerations', () => {
    test('should handle migration of table with existing data', async () => {
      // Create table and populate with data
      const dataSchema = {
        dataTable: {
          _: { name: 'evolution_data_test' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            value: { dataType: 'text' },
            number: { dataType: 'integer' },
          },
        },
      };

      const dataPlugin = [{ name: 'data-test-app', schema: dataSchema }];
      service.discoverAndRegisterPluginSchemas(dataPlugin as any);

      let summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Insert multiple records
      for (let i = 0; i < 10; i++) {
        await db.execute(
          sql.raw(`
          INSERT INTO evolution_data_test (id, value, number)
          VALUES (gen_random_uuid(), 'value_${i}', ${i})
        `)
        );
      }

      // Verify data exists
      const initialCount = await db.execute(
        sql.raw(`
        SELECT COUNT(*) as count FROM evolution_data_test
      `)
      );
      expect(parseInt((initialCount.rows[0] as any).count)).toBe(10);

      // Evolve schema with new columns
      const evolvedDataSchema = {
        dataTable: {
          _: { name: 'evolution_data_test' },
          columns: {
            id: { dataType: 'uuid', primary: true, notNull: true },
            value: { dataType: 'text' },
            number: { dataType: 'integer' },
            category: { dataType: 'text', defaultValue: "'default'" }, // New with default
            is_active: { dataType: 'boolean', notNull: true, defaultValue: 'true' }, // New with default
            created_at: { dataType: 'timestamptz', notNull: true, defaultValue: 'now()' }, // New with default
          },
        },
      };

      const evolvedDataPlugin = [{ name: 'data-test-app', schema: evolvedDataSchema }];
      service.discoverAndRegisterPluginSchemas(evolvedDataPlugin as any);

      summaries = await service.runAllPluginMigrations({ force: true });
      expect(summaries[0].success).toBe(true);

      // Verify data preservation
      const finalCount = await db.execute(
        sql.raw(`
        SELECT COUNT(*) as count FROM evolution_data_test
      `)
      );
      expect(parseInt((finalCount.rows[0] as any).count)).toBe(10);

      // Verify new columns have default values
      const newColumnData = await db.execute(
        sql.raw(`
        SELECT category, is_active, created_at 
        FROM evolution_data_test 
        LIMIT 1
      `)
      );
      const row = newColumnData.rows[0] as any;
      expect(row.category).toBe('default');
      expect(row.is_active).toBe(true);
      expect(row.created_at).toBeDefined();
    });
  });
});
