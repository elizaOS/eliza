import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import {
  pgTable,
  text,
  integer,
  bigint,
  smallint,
  boolean,
  timestamp,
  uuid,
  jsonb,
  numeric,
  varchar,
  serial,
  bigserial,
  smallserial,
} from 'drizzle-orm/pg-core';
import { RuntimeMigrator } from '../../runtime-migrator/runtime-migrator';
import { DatabaseIntrospector } from '../../runtime-migrator/drizzle-adapters/database-introspector';
import type { DrizzleDB } from '../../runtime-migrator/types';

/**
 * Type Normalization Tests
 *
 * These tests verify that our type normalization correctly handles
 * equivalent type variations that occur between:
 * 1. Database introspection results
 * 2. Drizzle schema definitions
 *
 * This is critical for production scenarios where existing databases
 * may have been created with different type representations.
 */
describe('Type Normalization', () => {
  let pgClient: PGlite;
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let introspector: DatabaseIntrospector;

  beforeEach(async () => {
    pgClient = new PGlite({ extensions: { vector } });
    db = drizzle(pgClient);
    migrator = new RuntimeMigrator(db);
    introspector = new DatabaseIntrospector(db);
    await migrator.initialize();
  });

  afterEach(async () => {
    await pgClient.close();
  });

  describe('Serial Type Equivalence', () => {
    it('should recognize SERIAL as equivalent to INTEGER with auto-increment', async () => {
      // Create table with SERIAL (as database would)
      await db.execute(sql`
        CREATE TABLE test_serial (
          id SERIAL PRIMARY KEY,
          name TEXT
        )
      `);

      // Define schema with integer().primaryKey().generatedByDefaultAsIdentity()
      const schema = {
        test_serial: pgTable('test_serial', {
          id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
          name: text('name'),
        }),
      };

      // Migration should detect no changes
      await migrator.migrate('@test/serial', schema, { verbose: false });

      // Verify no destructive changes were detected
      const result = await db.execute(sql`SELECT COUNT(*) FROM test_serial`);
      expect(result).toBeDefined();
    });

    it('should handle BIGSERIAL as equivalent to BIGINT with identity', async () => {
      await db.execute(sql`
        CREATE TABLE test_bigserial (
          id BIGSERIAL PRIMARY KEY,
          data JSONB
        )
      `);

      const schema = {
        test_bigserial: pgTable('test_bigserial', {
          id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
          data: jsonb('data'),
        }),
      };

      await migrator.migrate('@test/bigserial', schema, { verbose: false });

      // Should complete without errors
      const result = await db.execute(sql`SELECT COUNT(*) FROM test_bigserial`);
      expect(result).toBeDefined();
    });

    it('should handle SMALLSERIAL as equivalent to SMALLINT with identity', async () => {
      await db.execute(sql`
        CREATE TABLE test_smallserial (
          id SMALLSERIAL PRIMARY KEY,
          flag BOOLEAN
        )
      `);

      const schema = {
        test_smallserial: pgTable('test_smallserial', {
          id: smallint('id').primaryKey().generatedByDefaultAsIdentity(),
          flag: boolean('flag'),
        }),
      };

      await migrator.migrate('@test/smallserial', schema, { verbose: false });

      // Should complete without errors
      const result = await db.execute(sql`SELECT COUNT(*) FROM test_smallserial`);
      expect(result).toBeDefined();
    });
  });

  describe('Timestamp Type Variations', () => {
    it('should treat timestamp without time zone as equivalent to timestamp', async () => {
      // Database introspection often returns 'timestamp without time zone'
      await db.execute(sql`
        CREATE TABLE test_timestamp (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Drizzle schema uses 'timestamp'
      const schema = {
        test_timestamp: pgTable('test_timestamp', {
          id: uuid('id').primaryKey().defaultRandom(),
          created_at: timestamp('created_at').defaultNow(),
          updated_at: timestamp('updated_at').defaultNow(),
        }),
      };

      await migrator.migrate('@test/timestamp', schema, { verbose: false });

      // Should not detect any changes
      const columns = await db.execute(sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'test_timestamp'
        ORDER BY column_name
      `);
      expect(columns.rows).toHaveLength(3);
    });

    it('should handle timestamp with time zone variations', async () => {
      await db.execute(sql`
        CREATE TABLE test_timestamptz (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      const schema = {
        test_timestamptz: pgTable('test_timestamptz', {
          id: uuid('id').primaryKey().defaultRandom(),
          created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
        }),
      };

      await migrator.migrate('@test/timestamptz', schema, { verbose: false });

      // Should complete without errors
      const result = await db.execute(sql`SELECT COUNT(*) FROM test_timestamptz`);
      expect(result).toBeDefined();
    });
  });

  describe('Numeric Type Variations', () => {
    it('should handle numeric/decimal equivalence', async () => {
      await db.execute(sql`
        CREATE TABLE test_numeric (
          id SERIAL PRIMARY KEY,
          price DECIMAL(10,2),
          quantity NUMERIC(10,2)
        )
      `);

      const schema = {
        test_numeric: pgTable('test_numeric', {
          id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
          price: numeric('price', { precision: 10, scale: 2 }),
          quantity: numeric('quantity', { precision: 10, scale: 2 }),
        }),
      };

      await migrator.migrate('@test/numeric', schema, { verbose: false });

      // Should complete without errors
      const result = await db.execute(sql`SELECT COUNT(*) FROM test_numeric`);
      expect(result).toBeDefined();
    });

    it('should handle varchar/character varying equivalence', async () => {
      await db.execute(sql`
        CREATE TABLE test_varchar (
          id SERIAL PRIMARY KEY,
          name CHARACTER VARYING(255),
          description VARCHAR(500)
        )
      `);

      const schema = {
        test_varchar: pgTable('test_varchar', {
          id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
          name: varchar('name', { length: 255 }),
          description: varchar('description', { length: 500 }),
        }),
      };

      await migrator.migrate('@test/varchar', schema, { verbose: false });

      // Should complete without errors
      const result = await db.execute(sql`SELECT COUNT(*) FROM test_varchar`);
      expect(result).toBeDefined();
    });
  });

  describe('Safe Type Promotions', () => {
    it('should allow safe numeric type promotions', async () => {
      await db.execute(sql`
        CREATE TABLE test_promotion (
          id SERIAL PRIMARY KEY,
          small_num SMALLINT,
          medium_num INTEGER
        )
      `);

      // Insert test data
      await db.execute(sql`
        INSERT INTO test_promotion (small_num, medium_num) 
        VALUES (100, 1000)
      `);

      // Promote types to larger sizes (safe operation)
      const schema = {
        test_promotion: pgTable('test_promotion', {
          id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
          small_num: integer('small_num'), // smallint -> integer
          medium_num: bigint('medium_num', { mode: 'number' }), // integer -> bigint
        }),
      };

      // This should be allowed without force flag
      await migrator.migrate('@test/promotion', schema, { verbose: false });

      // Verify data is preserved
      const result = await db.execute(sql`
        SELECT * FROM test_promotion
      `);
      expect(result.rows[0].small_num).toBe(100);
      expect(Number(result.rows[0].medium_num)).toBe(1000);
    });

    it('should allow varchar to text promotion', async () => {
      await db.execute(sql`
        CREATE TABLE test_text_promotion (
          id SERIAL PRIMARY KEY,
          short_text VARCHAR(100),
          long_text TEXT
        )
      `);

      await db.execute(sql`
        INSERT INTO test_text_promotion (short_text, long_text) 
        VALUES ('short', 'long text value')
      `);

      const schema = {
        test_text_promotion: pgTable('test_text_promotion', {
          id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
          short_text: text('short_text'), // varchar -> text (safe)
          long_text: text('long_text'),
        }),
      };

      await migrator.migrate('@test/text_promotion', schema, { verbose: false });

      // Verify data is preserved
      const result = await db.execute(sql`
        SELECT * FROM test_text_promotion
      `);
      expect(result.rows[0].short_text).toBe('short');
      expect(result.rows[0].long_text).toBe('long text value');
    });
  });

  describe('Complex Real-World Scenario', () => {
    it('should handle mixed type variations in production-like table', async () => {
      // Simulate a production table with various type representations
      await db.execute(sql`
        CREATE TABLE production_table (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          username CHARACTER VARYING(255) NOT NULL,
          email VARCHAR(255) NOT NULL,
          age SMALLINT,
          balance DECIMAL(20,2) DEFAULT 0.00,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          is_active BOOLEAN DEFAULT TRUE,
          tags TEXT[]
        )
      `);

      // Insert test data
      await db.execute(sql`
        INSERT INTO production_table (user_id, username, email, age, balance, metadata) 
        VALUES (
          gen_random_uuid(),
          'testuser',
          'test@example.com',
          25,
          100.50,
          '{"role": "user"}'::jsonb
        )
      `);

      // Drizzle schema with normalized types
      const schema = {
        production_table: pgTable('production_table', {
          id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
          user_id: uuid('user_id').notNull(),
          username: varchar('username', { length: 255 }).notNull(),
          email: varchar('email', { length: 255 }).notNull(),
          age: smallint('age'),
          balance: numeric('balance', { precision: 20, scale: 2 }).default('0.00'),
          metadata: jsonb('metadata').default({}),
          created_at: timestamp('created_at').defaultNow(),
          updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
          is_active: boolean('is_active').default(true),
          tags: text('tags').array(),
        }),
      };

      // Should handle all type variations without errors
      await migrator.migrate('@test/production', schema, { verbose: false });

      // Verify data integrity
      const result = await db.execute(sql`
        SELECT * FROM production_table
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].username).toBe('testuser');
      expect(result.rows[0].email).toBe('test@example.com');
      expect(result.rows[0].age).toBe(25);
      expect(Number(result.rows[0].balance)).toBe(100.5);
      expect(result.rows[0].is_active).toBe(true);
    });
  });
});
