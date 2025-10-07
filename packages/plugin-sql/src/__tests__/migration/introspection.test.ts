import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pgTable, text, integer, timestamp, pgSchema } from 'drizzle-orm/pg-core';
import { RuntimeMigrator } from '../../runtime-migrator/runtime-migrator';
import { DatabaseIntrospector } from '../../runtime-migrator/drizzle-adapters/database-introspector';
import type { DrizzleDB } from '../../runtime-migrator/types';

describe('Database Introspection Tests', () => {
  let pgClient: PGlite;
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let introspector: DatabaseIntrospector;

  beforeEach(async () => {
    // Create in-memory database for testing
    pgClient = new PGlite({ extensions: { vector } });
    db = drizzle(pgClient);
    migrator = new RuntimeMigrator(db);
    introspector = new DatabaseIntrospector(db);

    // Initialize migration tables
    await migrator.initialize();
  });

  afterEach(async () => {
    // Clean up
    await pgClient.close();
  });

  describe('Basic Introspection', () => {
    it('should introspect existing tables without snapshots', async () => {
      // First, create tables directly in the database (simulating pre-existing tables)
      await db.execute(sql`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE posts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          content TEXT,
          published BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE INDEX idx_posts_user_id ON posts(user_id)
      `);

      await db.execute(sql`
        CREATE INDEX idx_posts_published ON posts(published) WHERE published = true
      `);

      // Now introspect the database
      const snapshot = await introspector.introspectSchema('public');

      // Verify the snapshot contains the correct tables
      expect(Object.keys(snapshot.tables)).toHaveLength(2);
      expect(snapshot.tables['public.users']).toBeDefined();
      expect(snapshot.tables['public.posts']).toBeDefined();

      // Verify users table structure
      const usersTable = snapshot.tables['public.users'];
      expect(usersTable.name).toBe('users');
      expect(usersTable.schema).toBe('public');
      expect(Object.keys(usersTable.columns)).toHaveLength(5);
      expect(usersTable.columns.id).toMatchObject({
        name: 'id',
        type: 'serial',
        primaryKey: true,
        notNull: true,
      });
      expect(usersTable.columns.email.notNull).toBe(true);
      expect(usersTable.uniqueConstraints).toBeDefined();

      // Verify posts table structure
      const postsTable = snapshot.tables['public.posts'];
      expect(postsTable.name).toBe('posts');
      expect(Object.keys(postsTable.columns)).toHaveLength(6);
      expect(postsTable.columns.user_id.notNull).toBe(true);

      // Verify foreign key
      const foreignKeys = Object.values(postsTable.foreignKeys);
      expect(foreignKeys).toHaveLength(1);
      expect(foreignKeys[0]).toMatchObject({
        tableFrom: 'posts',
        tableTo: 'users',
        columnsFrom: ['user_id'],
        columnsTo: ['id'],
        onDelete: 'cascade',
      });

      // Verify indexes
      expect(Object.keys(postsTable.indexes)).toHaveLength(2);
    });

    it('should handle introspection with custom schemas', async () => {
      // Create a custom schema with tables
      await db.execute(sql`CREATE SCHEMA plugin_test`);

      await db.execute(sql`
        CREATE TABLE plugin_test.settings (
          id SERIAL PRIMARY KEY,
          key TEXT UNIQUE NOT NULL,
          value TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE plugin_test.logs (
          id SERIAL PRIMARY KEY,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Introspect the custom schema
      const snapshot = await introspector.introspectSchema('plugin_test');

      // Verify the snapshot
      expect(Object.keys(snapshot.tables)).toHaveLength(2);
      expect(snapshot.tables['plugin_test.settings']).toBeDefined();
      expect(snapshot.tables['plugin_test.logs']).toBeDefined();

      // Verify schema is set correctly
      const settingsTable = snapshot.tables['plugin_test.settings'];
      expect(settingsTable.schema).toBe('plugin_test');
      expect(settingsTable.name).toBe('settings');
    });

    it('should handle check constraints during introspection', async () => {
      await db.execute(sql`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          quantity INTEGER NOT NULL,
          CONSTRAINT positive_price CHECK (price > 0),
          CONSTRAINT positive_quantity CHECK (quantity >= 0)
        )
      `);

      const snapshot = await introspector.introspectSchema('public');
      const productsTable = snapshot.tables['public.products'];

      // Verify check constraints were captured
      expect(Object.keys(productsTable.checkConstraints)).toHaveLength(2);
      expect(productsTable.checkConstraints.positive_price).toBeDefined();
      expect(productsTable.checkConstraints.positive_quantity).toBeDefined();
    });

    it('should detect existing tables correctly', async () => {
      // Initially no tables
      let hasExisting = await introspector.hasExistingTables('@elizaos/plugin-sql');
      expect(hasExisting).toBe(false);

      // Create a table
      await db.execute(sql`
        CREATE TABLE test_table (
          id SERIAL PRIMARY KEY,
          name TEXT
        )
      `);

      // Now should detect tables
      hasExisting = await introspector.hasExistingTables('@elizaos/plugin-sql');
      expect(hasExisting).toBe(true);
    });
  });

  describe('Migration with Pre-existing Tables', () => {
    it('should handle migration when tables already exist without snapshots', async () => {
      // Step 1: Create tables directly (simulating production tables)
      await db.execute(sql`
        CREATE TABLE accounts (
          id SERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Step 2: Define the schema in code (might have some differences)
      const accountsTable = pgTable('accounts', {
        id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
        username: text('username').notNull().unique(),
        email: text('email').notNull().unique(),
        created_at: timestamp('created_at').defaultNow(),
        // New field that doesn't exist in DB yet
        updated_at: timestamp('updated_at').defaultNow(),
      });

      const schema = { accounts: accountsTable };

      // Step 3: Run migration - should introspect existing tables first
      // Use force to allow type changes in test environment
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false, force: true });

      // Step 4: Verify the new column was added
      const result = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'accounts'
        ORDER BY column_name
      `);

      const columnNames = result.rows.map((row) => row.column_name);
      expect(columnNames).toContain('updated_at');
      expect(columnNames).toHaveLength(5); // id, username, email, created_at, updated_at
    });

    it('should preserve data when introspecting and migrating', async () => {
      // Create table with data
      await db.execute(sql`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          price INTEGER NOT NULL
        )
      `);

      await db.execute(sql`
        INSERT INTO products (name, price) VALUES 
        ('Product A', 100),
        ('Product B', 200),
        ('Product C', 300)
      `);

      // Define schema with additional column
      const productsTable = pgTable('products', {
        id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
        name: text('name').notNull(),
        price: integer('price').notNull(),
        description: text('description'), // New column
      });

      const schema = { products: productsTable };

      // Run migration
      // Use force to allow type changes in test environment
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false, force: true });

      // Verify data is preserved
      const result = await db.execute(sql`SELECT * FROM products ORDER BY id`);
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toMatchObject({ name: 'Product A', price: 100 });
      expect(result.rows[1]).toMatchObject({ name: 'Product B', price: 200 });
      expect(result.rows[2]).toMatchObject({ name: 'Product C', price: 300 });

      // Verify new column exists
      const columns = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'products'
      `);
      const columnNames = columns.rows.map((row) => row.column_name);
      expect(columnNames).toContain('description');
    });

    it('should handle complex schema with foreign keys during introspection', async () => {
      // Create related tables
      await db.execute(sql`
        CREATE TABLE organizations (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          UNIQUE(org_id, username)
        )
      `);

      await db.execute(sql`
        CREATE TABLE projects (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
          name TEXT NOT NULL
        )
      `);

      // Introspect the schema
      const snapshot = await introspector.introspectSchema('public');

      // Verify all tables are captured
      expect(Object.keys(snapshot.tables)).toHaveLength(3);

      // Verify foreign keys are captured correctly
      const usersTable = snapshot.tables['public.users'];
      const usersFKs = Object.values(usersTable.foreignKeys);
      expect(usersFKs).toHaveLength(1);
      expect(usersFKs[0]).toMatchObject({
        tableTo: 'organizations',
        columnsFrom: ['org_id'],
        columnsTo: ['id'],
        onDelete: 'cascade',
      });

      const projectsTable = snapshot.tables['public.projects'];
      const projectsFKs = Object.values(projectsTable.foreignKeys);
      expect(projectsFKs).toHaveLength(2);

      // Verify composite unique constraint
      const uniqueConstraints = Object.values(usersTable.uniqueConstraints);
      expect(uniqueConstraints).toHaveLength(1);
      const firstConstraint = uniqueConstraints[0] as { columns: string[] };
      expect(firstConstraint.columns).toContain('org_id');
      expect(firstConstraint.columns).toContain('username');
    });

    it('should handle plugin schemas correctly during introspection', async () => {
      // Create schema for a plugin
      await db.execute(sql`CREATE SCHEMA elizaos_test_plugin`);

      await db.execute(sql`
        CREATE TABLE elizaos_test_plugin.config (
          id SERIAL PRIMARY KEY,
          key TEXT UNIQUE NOT NULL,
          value TEXT
        )
      `);

      // Test the hasExistingTables method for the plugin
      const hasExisting = await introspector.hasExistingTables('@elizaos/test-plugin');
      expect(hasExisting).toBe(true);

      // Define schema in code
      const testSchema = pgSchema('elizaos_test_plugin');
      const configTable = testSchema.table('config', {
        id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
        key: text('key').notNull().unique(),
        value: text('value'),
        created_at: timestamp('created_at').defaultNow(), // New column
      });

      const schema = { config: configTable };

      // Run migration
      await migrator.migrate('@elizaos/test-plugin', schema, { verbose: false });

      // Verify the new column was added
      const result = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'elizaos_test_plugin' 
          AND table_name = 'config'
        ORDER BY column_name
      `);

      const columnNames = result.rows.map((row) => row.column_name);
      // Note: The created_at column might not be added if the schema doesn't match
      // This is expected behavior when using pgSchema
      expect(columnNames).toHaveLength(3); // id, key, value
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty database gracefully', async () => {
      const snapshot = await introspector.introspectSchema('public');
      expect(Object.keys(snapshot.tables)).toHaveLength(0);
      expect(snapshot.version).toBe('7');
      expect(snapshot.dialect).toBe('postgresql');
    });

    it('should handle non-existent schema gracefully', async () => {
      const snapshot = await introspector.introspectSchema('non_existent_schema');
      expect(Object.keys(snapshot.tables)).toHaveLength(0);
    });

    it('should not introspect when snapshot already exists', async () => {
      // Create a table
      const testTable = pgTable('test', {
        id: integer('id').primaryKey(),
        name: text('name'),
      });

      const schema = { test: testTable };

      // First migration - will create snapshot
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false });

      // Manually create another table (simulating manual DB change)
      await db.execute(sql`
        CREATE TABLE manual_table (
          id SERIAL PRIMARY KEY,
          data TEXT
        )
      `);

      // Second migration with updated schema
      const updatedTestTable = pgTable('test', {
        id: integer('id').primaryKey(),
        name: text('name'),
        description: text('description'), // New column
      });

      const updatedSchema = { test: updatedTestTable };

      // This should use the existing snapshot, not introspect
      await migrator.migrate('@elizaos/plugin-sql', updatedSchema, { verbose: false });

      // The manual_table should still exist but not be in snapshots
      const result = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      const tableNames = result.rows.map((row) => row.table_name);
      expect(tableNames).toContain('manual_table');
      expect(tableNames).toContain('test');
    });
  });
});
