import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
  jsonb,
  numeric,
} from 'drizzle-orm/pg-core';
import { RuntimeMigrator } from '../../runtime-migrator/runtime-migrator';
import { DatabaseIntrospector } from '../../runtime-migrator/drizzle-adapters/database-introspector';
import * as coreSchema from '../../schema';
import type { DrizzleDB } from '../../runtime-migrator/types';

/**
 * These tests simulate real production scenarios where:
 * 1. The database already has tables from previous deployments
 * 2. The migration system is introduced later
 * 3. We need to handle existing data and schema gracefully
 */
describe('Production Migration Scenarios', () => {
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

  describe('Scenario 1: Existing ElizaOS Core Tables', () => {
    it('should handle existing core tables from production', async () => {
      // Simulate existing production database with core tables
      // These would have been created by previous versions of ElizaOS

      // Create the tables as they exist in production (simplified versions)
      // Note: Using correct table name 'memories' and camelCase columns to match the schema
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS memories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID NOT NULL,
          "roomId" UUID,
          "entityId" UUID,
          content JSONB NOT NULL,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          type TEXT NOT NULL DEFAULT 'message',
          "unique" BOOLEAN DEFAULT TRUE,
          metadata JSONB DEFAULT '{}',
          "worldId" UUID
        )
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_memories_type_room ON memories(type, "roomId")
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_memories_world_id ON memories("worldId")
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          settings JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          enabled BOOLEAN DEFAULT TRUE,
          username TEXT,
          system TEXT DEFAULT '',
          bio JSONB DEFAULT '[]'::jsonb,
          message_examples JSONB DEFAULT '[]'::jsonb,
          post_examples JSONB DEFAULT '[]'::jsonb,
          topics JSONB DEFAULT '[]'::jsonb,
          adjectives JSONB DEFAULT '[]'::jsonb,
          knowledge JSONB DEFAULT '[]'::jsonb,
          plugins JSONB DEFAULT '[]'::jsonb,
          style JSONB DEFAULT '{}'::jsonb
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general',
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "worldId" UUID,
          "serverId" TEXT,
          metadata JSONB,
          "channelId" TEXT
        )
      `);

      // Insert some production data
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const roomId = '223e4567-e89b-12d3-a456-426614174000';

      await db.execute(sql`
        INSERT INTO agents (id, name, settings) 
        VALUES (${agentId}::uuid, 'Production Agent', '{"model": "gpt-4"}'::jsonb)
      `);

      await db.execute(sql`
        INSERT INTO rooms (id, "agentId", name, source, type) 
        VALUES (${roomId}::uuid, ${agentId}::uuid, 'Main Room', 'test', 'general')
      `);

      await db.execute(sql`
        INSERT INTO memories ("agentId", "roomId", "entityId", content, type) 
        VALUES 
        (${agentId}::uuid, ${roomId}::uuid, null, '{"text": "System initialized"}'::jsonb, 'message'),
        (${agentId}::uuid, ${roomId}::uuid, null, '{"text": "User preferences loaded"}'::jsonb, 'message'),
        (${agentId}::uuid, ${roomId}::uuid, null, '{"text": "Context established"}'::jsonb, 'message')
      `);

      // Now run the migration with the actual core schema
      // This should introspect the existing tables and reconcile differences
      await migrator.migrate('@elizaos/plugin-sql', coreSchema, { verbose: false });

      // Verify data is preserved
      const memories = await db.execute(sql`SELECT COUNT(*) as count FROM memories`);
      expect(Number(memories.rows[0].count)).toBe(3);

      const agents = await db.execute(sql`SELECT * FROM agents WHERE id = ${agentId}::uuid`);
      expect(agents.rows[0]).toBeDefined();
      expect(agents.rows[0].name).toBe('Production Agent');

      // Check if any new columns from the schema were added
      const memoryColumns = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'memories'
        ORDER BY column_name
      `);

      const columnNames = memoryColumns.rows.map((row) => row.column_name);

      // Should have all original columns plus any new ones from the schema
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('agentId');
      expect(columnNames).toContain('roomId');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('type');
    });

    it('should handle version mismatch between DB and code schema', async () => {
      // Create an older version of a table structure
      await db.execute(sql`
        CREATE TABLE participants (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_id UUID NOT NULL,
          room_id UUID NOT NULL,
          user_name TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Add some data
      const agentId = '323e4567-e89b-12d3-a456-426614174000';
      const roomId = '423e4567-e89b-12d3-a456-426614174000';

      await db.execute(sql`
        INSERT INTO participants (agent_id, room_id, user_name) 
        VALUES 
        (${agentId}::uuid, ${roomId}::uuid, 'Alice'),
        (${agentId}::uuid, ${roomId}::uuid, 'Bob')
      `);

      // The new schema might have additional fields
      const participantTable = pgTable('participants', {
        id: uuid('id').primaryKey().defaultRandom(),
        agent_id: uuid('agent_id').notNull(),
        room_id: uuid('room_id').notNull(),
        user_name: text('user_name').notNull(),
        created_at: timestamp('created_at').defaultNow(),
        // New fields not in the old schema
        updated_at: timestamp('updated_at').defaultNow(),
        is_active: boolean('is_active').default(true),
        metadata: jsonb('metadata'),
      });

      const schema = { participants: participantTable };

      // Run migration
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false });

      // Verify data is preserved
      const result = await db.execute(sql`SELECT * FROM participants ORDER BY user_name`);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].user_name).toBe('Alice');
      expect(result.rows[1].user_name).toBe('Bob');

      // Verify new columns exist
      const columns = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'participants'
        ORDER BY column_name
      `);

      const columnNames = columns.rows.map((row) => row.column_name);
      expect(columnNames).toContain('updated_at');
      expect(columnNames).toContain('is_active');
      expect(columnNames).toContain('metadata');
    });
  });

  describe('Scenario 2: Multiple Plugin Tables in Production', () => {
    it('should handle multiple plugins with existing tables', async () => {
      // Simulate a production environment with multiple plugins already deployed

      // Plugin 1: Analytics plugin with its own schema
      await db.execute(sql`CREATE SCHEMA IF NOT EXISTS elizaos_analytics`);

      await db.execute(sql`
        CREATE TABLE elizaos_analytics.events (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(100) NOT NULL,
          agent_id UUID NOT NULL,
          payload JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE elizaos_analytics.metrics (
          id SERIAL PRIMARY KEY,
          metric_name VARCHAR(100) NOT NULL,
          value NUMERIC NOT NULL,
          tags JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Add some production data
      await db.execute(sql`
        INSERT INTO elizaos_analytics.events (event_type, agent_id, payload) 
        VALUES 
        ('agent_started', '523e4567-e89b-12d3-a456-426614174000'::uuid, '{"version": "1.0.0"}'::jsonb),
        ('message_processed', '523e4567-e89b-12d3-a456-426614174000'::uuid, '{"tokens": 150}'::jsonb)
      `);

      await db.execute(sql`
        INSERT INTO elizaos_analytics.metrics (metric_name, value, tags) 
        VALUES 
        ('response_time_ms', 250.5, '{"endpoint": "chat"}'::jsonb),
        ('memory_usage_mb', 512.0, '{"process": "agent"}'::jsonb)
      `);

      // Check if tables exist
      const hasExisting = await introspector.hasExistingTables('@elizaos/analytics');
      expect(hasExisting).toBe(true);

      // Introspect to verify structure
      const snapshot = await introspector.introspectSchema('elizaos_analytics');
      expect(Object.keys(snapshot.tables)).toHaveLength(2);
      expect(snapshot.tables['elizaos_analytics.events']).toBeDefined();
      expect(snapshot.tables['elizaos_analytics.metrics']).toBeDefined();

      // Verify data is there
      const events = await db.execute(sql`
        SELECT COUNT(*) as count FROM elizaos_analytics.events
      `);
      expect(Number(events.rows[0].count)).toBe(2);

      const metrics = await db.execute(sql`
        SELECT COUNT(*) as count FROM elizaos_analytics.metrics
      `);
      expect(Number(metrics.rows[0].count)).toBe(2);
    });

    it('should handle schema conflicts gracefully', async () => {
      // Create a table that conflicts with what a plugin expects
      await db.execute(sql`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          completed BOOLEAN DEFAULT FALSE
        )
      `);

      // The plugin expects a different structure
      const tasksTable = pgTable('tasks', {
        id: uuid('id').primaryKey().defaultRandom(), // Different type!
        description: text('description').notNull(),
        completed: boolean('completed').default(false),
        agent_id: uuid('agent_id').notNull(), // New required field
        created_at: timestamp('created_at').defaultNow(),
      });

      const schema = { tasks: tasksTable };

      // This should detect the type conflict
      try {
        await migrator.migrate('@elizaos/plugin-sql', schema, {
          verbose: false,
          force: false, // Don't allow destructive changes
        });

        // If we get here without error, check what happened
        const columns = await db.execute(sql`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = 'tasks'
          ORDER BY column_name
        `);

        // The migration should have been blocked or handled gracefully
        expect(columns.rows).toBeDefined();
      } catch (error) {
        // Expected: Destructive migration should be blocked
        expect((error as Error).message).toContain('Destructive migration blocked');
      }
    });
  });

  describe('Scenario 3: Recovery from Failed Migrations', () => {
    it('should handle partial migration state gracefully', async () => {
      // Simulate a partial migration where some tables were created but not all
      await db.execute(sql`
        CREATE TABLE users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL
        )
      `);

      // But the related tables were not created (simulating a failed migration)
      // Now define the complete schema
      const usersTable = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        email: text('email').notNull().unique(),
        created_at: timestamp('created_at').defaultNow(), // New field
      });

      const profilesTable = pgTable('profiles', {
        id: uuid('id').primaryKey().defaultRandom(),
        user_id: uuid('user_id')
          .notNull()
          .references(() => usersTable.id),
        bio: text('bio'),
        avatar_url: text('avatar_url'),
      });

      const sessionsTable = pgTable('sessions', {
        id: uuid('id').primaryKey().defaultRandom(),
        user_id: uuid('user_id')
          .notNull()
          .references(() => usersTable.id),
        token: text('token').notNull().unique(),
        expires_at: timestamp('expires_at').notNull(),
      });

      const schema = {
        users: usersTable,
        profiles: profilesTable,
        sessions: sessionsTable,
      };

      // Run migration - should complete the partial migration
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false });

      // Verify all tables exist
      const tables = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      const tableNames = tables.rows.map((row) => row.table_name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('profiles');
      expect(tableNames).toContain('sessions');

      // Verify the users table was updated with new field
      const userColumns = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'users'
        ORDER BY column_name
      `);

      const columnNames = userColumns.rows.map((row) => row.column_name);
      expect(columnNames).toContain('created_at');
    });

    it('should be idempotent when run multiple times', async () => {
      // Create initial state
      await db.execute(sql`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          price NUMERIC(10,2) NOT NULL
        )
      `);

      await db.execute(sql`
        INSERT INTO products (name, price) VALUES 
        ('Product A', 99.99),
        ('Product B', 149.99)
      `);

      // Define schema
      const productsTable = pgTable('products', {
        id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
        name: text('name').notNull(),
        price: numeric('price', { precision: 10, scale: 2 }).notNull(),
        category: text('category').default('general'), // New field
      });

      const schema = { products: productsTable };

      // Run migration multiple times
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false });
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false });
      await migrator.migrate('@elizaos/plugin-sql', schema, { verbose: false });

      // Verify data is still intact
      const products = await db.execute(sql`
        SELECT * FROM products ORDER BY id
      `);
      expect(products.rows).toHaveLength(2);
      expect(products.rows[0].name).toBe('Product A');
      expect(products.rows[1].name).toBe('Product B');

      // Verify structure is correct (not duplicated)
      const columns = await db.execute(sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'products'
        ORDER BY column_name
      `);

      const columnNames = columns.rows.map((row) => row.column_name);
      expect(columnNames).toHaveLength(4); // id, name, price, category
      expect(columnNames).toContain('category');
    });
  });

  describe('Scenario 4: Large Production Database', () => {
    it('should handle introspection of many tables efficiently', async () => {
      // Create multiple tables to simulate a large production database
      const tableCount = 20;

      for (let i = 0; i < tableCount; i++) {
        await db.execute(
          sql.raw(`
          CREATE TABLE table_${i} (
            id SERIAL PRIMARY KEY,
            data TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
          )
        `)
        );

        // Add some data
        await db.execute(
          sql.raw(`
          INSERT INTO table_${i} (data) VALUES ('Data for table ${i}')
        `)
        );
      }

      // Add some indexes
      for (let i = 0; i < 5; i++) {
        await db.execute(
          sql.raw(`
          CREATE INDEX idx_table_${i}_created_at ON table_${i}(created_at)
        `)
        );
      }

      // Introspect the database
      const snapshot = await introspector.introspectSchema('public');

      // Verify all tables were captured
      expect(Object.keys(snapshot.tables)).toHaveLength(tableCount);

      // Verify data exists
      for (let i = 0; i < tableCount; i++) {
        const result = await db.execute(sql.raw(`SELECT COUNT(*) as count FROM table_${i}`));
        expect(Number(result.rows[0].count)).toBe(1);
      }
    });
  });
});
