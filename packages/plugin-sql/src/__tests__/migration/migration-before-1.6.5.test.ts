/**
 * Tests for migrations.ts - migrateToEntityRLS function
 *
 * These tests verify the migration from pre-1.6.5 (camelCase) to 1.6.5+ (snake_case)
 * including RLS cleanup and column renames.
 *
 * Works with both PGLite (default) and PostgreSQL (when POSTGRES_URL is set).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrateToEntityRLS } from '../../migrations';

describe('migrateToEntityRLS (pre-1.6.5 migration)', () => {
  let pgClient: PGlite;
  let db: any;
  let mockAdapter: any;

  beforeEach(async () => {
    pgClient = new PGlite({ extensions: { vector } });
    db = drizzle(pgClient);

    // Create a mock adapter with the db property
    mockAdapter = {
      db,
      getDatabase: () => db,
    };
  });

  afterEach(async () => {
    await pgClient.close();
  });

  describe('Flow 1: Fresh install (no tables)', () => {
    it('should return early when rooms table does not exist', async () => {
      // No tables created - should return early without error
      await migrateToEntityRLS(mockAdapter);

      // Verify no tables were created (migration returned early)
      const tablesResult = await db.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);

      // Only system tables should exist (if any)
      const tableNames = tablesResult.rows.map((r: any) => r.table_name);
      expect(tableNames).not.toContain('rooms');
      expect(tableNames).not.toContain('memories');
    });
  });

  describe('Flow 2: Migration from pre-1.6.5 (camelCase columns)', () => {
    beforeEach(async () => {
      // Create tables with camelCase columns (simulating pre-1.6.5)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "worldId" UUID,
          "channelId" TEXT,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS memories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID NOT NULL,
          "roomId" UUID,
          "entityId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "worldId" UUID,
          content JSONB NOT NULL,
          type TEXT NOT NULL DEFAULT 'message'
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS worlds (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "serverId" TEXT,
          "createdAt" TIMESTAMP DEFAULT NOW()
        )
      `);
    });

    it('should rename camelCase columns to snake_case', async () => {
      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // Verify rooms columns are now snake_case
      const roomsColumns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rooms'
        ORDER BY column_name
      `);
      const roomColumnNames = roomsColumns.rows.map((r: any) => r.column_name);

      expect(roomColumnNames).toContain('agent_id');
      expect(roomColumnNames).toContain('world_id');
      expect(roomColumnNames).toContain('channel_id');
      expect(roomColumnNames).toContain('created_at');
      expect(roomColumnNames).not.toContain('agentId');
      expect(roomColumnNames).not.toContain('worldId');
      expect(roomColumnNames).not.toContain('channelId');
      expect(roomColumnNames).not.toContain('createdAt');
    });

    it('should rename memories camelCase columns to snake_case', async () => {
      await migrateToEntityRLS(mockAdapter);

      const memoriesColumns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'memories'
        ORDER BY column_name
      `);
      const memoryColumnNames = memoriesColumns.rows.map((r: any) => r.column_name);

      expect(memoryColumnNames).toContain('agent_id');
      expect(memoryColumnNames).toContain('room_id');
      expect(memoryColumnNames).toContain('entity_id');
      expect(memoryColumnNames).toContain('created_at');
      expect(memoryColumnNames).toContain('world_id');
      expect(memoryColumnNames).not.toContain('agentId');
      expect(memoryColumnNames).not.toContain('roomId');
      expect(memoryColumnNames).not.toContain('entityId');
    });

    it('should rename worlds.serverId to message_server_id', async () => {
      await migrateToEntityRLS(mockAdapter);

      const worldsColumns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'worlds'
        ORDER BY column_name
      `);
      const worldColumnNames = worldsColumns.rows.map((r: any) => r.column_name);

      expect(worldColumnNames).toContain('message_server_id');
      expect(worldColumnNames).not.toContain('serverId');
      expect(worldColumnNames).not.toContain('server_id');
    });

    it('should preserve data during column renames', async () => {
      // Insert test data before migration
      const agentId = '123e4567-e89b-12d3-a456-426614174000';
      const roomId = '223e4567-e89b-12d3-a456-426614174000';

      await db.execute(sql`
        INSERT INTO agents (id, name) VALUES (${agentId}::uuid, 'Test Agent')
      `);

      await db.execute(sql`
        INSERT INTO rooms (id, "agentId", name, source, type)
        VALUES (${roomId}::uuid, ${agentId}::uuid, 'Test Room', 'test', 'general')
      `);

      await db.execute(sql`
        INSERT INTO memories ("agentId", "roomId", content, type)
        VALUES (${agentId}::uuid, ${roomId}::uuid, '{"text": "Hello"}'::jsonb, 'message')
      `);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // Verify data is preserved
      const agents = await db.execute(sql`SELECT * FROM agents WHERE id = ${agentId}::uuid`);
      expect(agents.rows[0].name).toBe('Test Agent');

      const rooms = await db.execute(sql`SELECT * FROM rooms WHERE id = ${roomId}::uuid`);
      expect(rooms.rows[0].name).toBe('Test Room');
      expect(rooms.rows[0].agent_id).toBe(agentId);

      const memories = await db.execute(
        sql`SELECT * FROM memories WHERE agent_id = ${agentId}::uuid`
      );
      expect(memories.rows).toHaveLength(1);
      expect(memories.rows[0].room_id).toBe(roomId);
    });
  });

  describe('Flow 3: Already migrated (snake_case columns exist)', () => {
    beforeEach(async () => {
      // Create tables with snake_case columns (already migrated)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_id UUID,
          world_id UUID,
          channel_id TEXT,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Insert test data
      await db.execute(sql`
        INSERT INTO agents (id, name) VALUES ('123e4567-e89b-12d3-a456-426614174000'::uuid, 'Test Agent')
      `);

      await db.execute(sql`
        INSERT INTO rooms (id, agent_id, name, source, type)
        VALUES ('223e4567-e89b-12d3-a456-426614174000'::uuid, '123e4567-e89b-12d3-a456-426614174000'::uuid, 'Test Room', 'test', 'general')
      `);
    });

    it('should skip schema migration but still run RLS cleanup', async () => {
      // This test verifies RLS cleanup when data isolation is DISABLED
      // Save and unset ENABLE_DATA_ISOLATION to test cleanup behavior
      const savedEnableDataIsolation = process.env.ENABLE_DATA_ISOLATION;
      delete process.env.ENABLE_DATA_ISOLATION;

      try {
        // Enable RLS on rooms table to test cleanup
        await db.execute(sql`ALTER TABLE rooms ENABLE ROW LEVEL SECURITY`);

        // Verify RLS is enabled
        const beforeRls = await db.execute(sql`
          SELECT relrowsecurity FROM pg_class WHERE relname = 'rooms'
        `);
        expect(beforeRls.rows[0].relrowsecurity).toBe(true);

        // Run migration (should skip schema changes but do RLS cleanup)
        await migrateToEntityRLS(mockAdapter);

        // Verify RLS is disabled (cleanup happened)
        const afterRls = await db.execute(sql`
          SELECT relrowsecurity FROM pg_class WHERE relname = 'rooms'
        `);
        expect(afterRls.rows[0].relrowsecurity).toBe(false);

        // Verify data is still intact
        const rooms = await db.execute(sql`SELECT * FROM rooms`);
        expect(rooms.rows).toHaveLength(1);
        expect(rooms.rows[0].name).toBe('Test Room');
      } finally {
        // Restore environment
        if (savedEnableDataIsolation !== undefined) {
          process.env.ENABLE_DATA_ISOLATION = savedEnableDataIsolation;
        }
      }
    });

    it('should not modify existing snake_case columns', async () => {
      await migrateToEntityRLS(mockAdapter);

      const roomsColumns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rooms'
        ORDER BY column_name
      `);
      const roomColumnNames = roomsColumns.rows.map((r: any) => r.column_name);

      // Should still have snake_case columns
      expect(roomColumnNames).toContain('agent_id');
      expect(roomColumnNames).toContain('world_id');
      expect(roomColumnNames).toContain('channel_id');
      expect(roomColumnNames).toContain('created_at');
    });

    it('should NOT disable RLS when ENABLE_DATA_ISOLATION=true (avoid wasteful cycle)', async () => {
      // Enable RLS on rooms table
      await db.execute(sql`ALTER TABLE rooms ENABLE ROW LEVEL SECURITY`);

      // Verify RLS is enabled
      const beforeRls = await db.execute(sql`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'rooms'
      `);
      expect(beforeRls.rows[0].relrowsecurity).toBe(true);

      // Set ENABLE_DATA_ISOLATION=true
      const originalEnv = process.env.ENABLE_DATA_ISOLATION;
      process.env.ENABLE_DATA_ISOLATION = 'true';

      try {
        // Run migration (should NOT disable RLS because ENABLE_DATA_ISOLATION=true)
        await migrateToEntityRLS(mockAdapter);

        // Verify RLS is STILL enabled (no wasteful disable/re-enable cycle)
        const afterRls = await db.execute(sql`
          SELECT relrowsecurity FROM pg_class WHERE relname = 'rooms'
        `);
        expect(afterRls.rows[0].relrowsecurity).toBe(true);

        // Verify data is still intact
        const rooms = await db.execute(sql`SELECT * FROM rooms`);
        expect(rooms.rows).toHaveLength(1);
        expect(rooms.rows[0].name).toBe('Test Room');
      } finally {
        // Restore original env
        if (originalEnv === undefined) {
          delete process.env.ENABLE_DATA_ISOLATION;
        } else {
          process.env.ENABLE_DATA_ISOLATION = originalEnv;
        }
      }
    });
  });

  describe('Flow 4: serverId to message_server_id migration', () => {
    it('should convert TEXT serverId to UUID message_server_id with valid UUID', async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          "serverId" TEXT,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Insert with valid UUID as text
      const serverId = '323e4567-e89b-12d3-a456-426614174000';
      await db.execute(sql`
        INSERT INTO rooms (id, "serverId", name, source, type)
        VALUES ('223e4567-e89b-12d3-a456-426614174000'::uuid, ${serverId}, 'Test Room', 'test', 'general')
      `);

      await migrateToEntityRLS(mockAdapter);

      // Verify column was renamed and converted to UUID
      const roomsColumns = await db.execute(sql`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'message_server_id'
      `);

      expect(roomsColumns.rows).toHaveLength(1);
      expect(roomsColumns.rows[0].data_type).toBe('uuid');

      // Verify data was preserved
      const rooms = await db.execute(sql`SELECT message_server_id FROM rooms`);
      expect(rooms.rows[0].message_server_id).toBe(serverId);
    });

    it('should convert non-UUID TEXT serverId to md5 UUID', async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          "serverId" TEXT,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Insert with non-UUID text
      await db.execute(sql`
        INSERT INTO rooms (id, "serverId", name, source, type)
        VALUES ('223e4567-e89b-12d3-a456-426614174000'::uuid, 'my-server-name', 'Test Room', 'test', 'general')
      `);

      await migrateToEntityRLS(mockAdapter);

      // Verify data was converted (md5 hash of 'my-server-name')
      const rooms = await db.execute(sql`SELECT message_server_id FROM rooms`);
      expect(rooms.rows[0].message_server_id).toBeDefined();
      // The value should be a valid UUID (md5 hash)
      expect(rooms.rows[0].message_server_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should handle NULL serverId values', async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          "serverId" TEXT,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Insert with NULL serverId
      await db.execute(sql`
        INSERT INTO rooms (id, "serverId", name, source, type)
        VALUES ('223e4567-e89b-12d3-a456-426614174000'::uuid, NULL, 'Test Room', 'test', 'general')
      `);

      await migrateToEntityRLS(mockAdapter);

      // Verify NULL was preserved
      const rooms = await db.execute(sql`SELECT message_server_id FROM rooms`);
      expect(rooms.rows[0].message_server_id).toBeNull();
    });
  });

  describe('Flow 5: owner_id to server_id migration (agents table)', () => {
    it('should rename agents.owner_id to server_id', async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          owner_id UUID,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Also need rooms table for migration check
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      const ownerId = '423e4567-e89b-12d3-a456-426614174000';
      await db.execute(sql`
        INSERT INTO agents (id, name, owner_id)
        VALUES ('123e4567-e89b-12d3-a456-426614174000'::uuid, 'Test Agent', ${ownerId}::uuid)
      `);

      await migrateToEntityRLS(mockAdapter);

      // Verify column was renamed
      const agentsColumns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agents'
        ORDER BY column_name
      `);
      const agentColumnNames = agentsColumns.rows.map((r: any) => r.column_name);

      expect(agentColumnNames).toContain('server_id');
      expect(agentColumnNames).not.toContain('owner_id');

      // Verify data was preserved
      const agents = await db.execute(sql`SELECT server_id FROM agents`);
      expect(agents.rows[0].server_id).toBe(ownerId);
    });
  });

  describe('Flow 6: Other plugin tables in public schema', () => {
    beforeEach(async () => {
      // Create plugin-sql required tables with camelCase columns (pre-1.6.5)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Create a table from another plugin (e.g., plugin-twitter)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS twitter_posts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tweet_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Create another plugin table with server_id column (potential conflict!)
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS custom_plugin_data (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          server_id UUID,
          data JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
    });

    it('should DROP server_id from unknown plugin tables (current behavior - potential issue)', async () => {
      // Insert test data in custom_plugin_data
      const serverId = '523e4567-e89b-12d3-a456-426614174000';
      await db.execute(sql`
        INSERT INTO custom_plugin_data (id, server_id, data)
        VALUES ('623e4567-e89b-12d3-a456-426614174000'::uuid, ${serverId}::uuid, '{"key": "value"}'::jsonb)
      `);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // Check if server_id column was preserved or deleted
      const columns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'custom_plugin_data'
        ORDER BY column_name
      `);
      const columnNames = columns.rows.map((r: any) => r.column_name);

      // CURRENT BEHAVIOR: migrations.ts DROPS server_id from tables not in exclusion list
      // This is DOCUMENTED BEHAVIOR - other plugins should NOT use server_id column name
      expect(columnNames).not.toContain('server_id'); // server_id is DROPPED
    });

    it('should preserve other plugin tables with their data intact', async () => {
      // Insert test data
      await db.execute(sql`
        INSERT INTO twitter_posts (id, tweet_id, author_id, content)
        VALUES ('723e4567-e89b-12d3-a456-426614174000'::uuid, '12345', 'user123', 'Hello Twitter!')
      `);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // Verify twitter_posts table and data are intact
      const tweets = await db.execute(sql`SELECT * FROM twitter_posts`);
      expect(tweets.rows).toHaveLength(1);
      expect(tweets.rows[0].content).toBe('Hello Twitter!');
      expect(tweets.rows[0].tweet_id).toBe('12345');
    });

    it('should disable RLS on other plugin tables during migration', async () => {
      // Enable RLS on twitter_posts
      await db.execute(sql`ALTER TABLE twitter_posts ENABLE ROW LEVEL SECURITY`);

      // Verify RLS is enabled
      const beforeRls = await db.execute(sql`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'twitter_posts'
      `);
      expect(beforeRls.rows[0].relrowsecurity).toBe(true);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // RLS should be disabled on ALL tables including other plugins
      const afterRls = await db.execute(sql`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'twitter_posts'
      `);
      expect(afterRls.rows[0].relrowsecurity).toBe(false);
    });

    it('should NOT rename columns in other plugin tables', async () => {
      // Insert test data
      await db.execute(sql`
        INSERT INTO twitter_posts (id, tweet_id, author_id, content)
        VALUES ('723e4567-e89b-12d3-a456-426614174000'::uuid, '12345', 'user123', 'Hello!')
      `);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // Verify columns are unchanged
      const columns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'twitter_posts'
        ORDER BY column_name
      `);
      const columnNames = columns.rows.map((r: any) => r.column_name);

      expect(columnNames).toContain('tweet_id');
      expect(columnNames).toContain('author_id');
      expect(columnNames).toContain('created_at');
    });
  });

  describe('Flow 7: Tables in non-public schemas', () => {
    beforeEach(async () => {
      // Create plugin-sql required tables
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Create a separate schema
      await db.execute(sql`CREATE SCHEMA IF NOT EXISTS other_schema`);

      // Create table in other_schema with server_id and camelCase columns
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS other_schema.custom_table (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          server_id UUID,
          "agentId" UUID,
          data JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
    });

    it('should NOT touch tables in non-public schemas', async () => {
      // Insert test data
      const serverId = '823e4567-e89b-12d3-a456-426614174000';
      const agentId = '923e4567-e89b-12d3-a456-426614174000';
      await db.execute(sql`
        INSERT INTO other_schema.custom_table (id, server_id, "agentId", data)
        VALUES ('a23e4567-e89b-12d3-a456-426614174000'::uuid, ${serverId}::uuid, ${agentId}::uuid, '{"key": "value"}'::jsonb)
      `);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // Verify table in other_schema is completely untouched
      const columns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'other_schema' AND table_name = 'custom_table'
        ORDER BY column_name
      `);
      const columnNames = columns.rows.map((r: any) => r.column_name);

      // server_id should still exist (not dropped)
      expect(columnNames).toContain('server_id');
      // agentId should NOT be renamed to agent_id
      expect(columnNames).toContain('agentId');
      expect(columnNames).not.toContain('agent_id');

      // Verify data is intact
      const data = await db.execute(sql`SELECT * FROM other_schema.custom_table`);
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0].server_id).toBe(serverId);
    });

    it('should NOT disable RLS on tables in non-public schemas', async () => {
      // Enable RLS on other_schema.custom_table
      await db.execute(sql`ALTER TABLE other_schema.custom_table ENABLE ROW LEVEL SECURITY`);

      // Verify RLS is enabled
      const beforeRls = await db.execute(sql`
        SELECT relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'custom_table' AND n.nspname = 'other_schema'
      `);
      expect(beforeRls.rows[0].relrowsecurity).toBe(true);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // RLS should still be enabled (migration doesn't touch other schemas)
      const afterRls = await db.execute(sql`
        SELECT relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'custom_table' AND n.nspname = 'other_schema'
      `);
      expect(afterRls.rows[0].relrowsecurity).toBe(true);
    });
  });

  describe('Flow 8: Indexes from other plugins', () => {
    beforeEach(async () => {
      // Create plugin-sql required tables
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      // Create another plugin table with custom indexes
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS analytics_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_type TEXT NOT NULL,
          user_id UUID NOT NULL,
          timestamp TIMESTAMP DEFAULT NOW()
        )
      `);

      // Create custom indexes on the analytics table
      await db.execute(sql`CREATE INDEX idx_analytics_event_type ON analytics_events(event_type)`);
      await db.execute(sql`CREATE INDEX idx_analytics_user_id ON analytics_events(user_id)`);
    });

    it('should drop ALL indexes in public schema including other plugins (current behavior)', async () => {
      // Insert test data
      await db.execute(sql`
        INSERT INTO analytics_events (id, event_type, user_id)
        VALUES ('b23e4567-e89b-12d3-a456-426614174000'::uuid, 'page_view', 'c23e4567-e89b-12d3-a456-426614174000'::uuid)
      `);

      // Verify indexes exist
      const beforeIndexes = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'analytics_events'
        AND indexname NOT LIKE '%_pkey'
      `);
      expect(beforeIndexes.rows.length).toBeGreaterThanOrEqual(2);

      // Run migration
      await migrateToEntityRLS(mockAdapter);

      // CURRENT BEHAVIOR: ALL regular indexes are dropped (including from other plugins)
      // This is DOCUMENTED BEHAVIOR - indexes are recreated by RuntimeMigrator
      const afterIndexes = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'analytics_events'
        AND indexname NOT LIKE '%_pkey'
      `);
      expect(afterIndexes.rows.length).toBe(0); // All indexes dropped

      // Verify data is still intact though
      const events = await db.execute(sql`SELECT * FROM analytics_events`);
      expect(events.rows).toHaveLength(1);
    });
  });

  describe('Idempotency', () => {
    it('should be safe to run multiple times', async () => {
      // Create tables with camelCase
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "agentId" UUID,
          "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          type TEXT NOT NULL DEFAULT 'general'
        )
      `);

      await db.execute(sql`
        INSERT INTO rooms (id, name, source, type)
        VALUES ('223e4567-e89b-12d3-a456-426614174000'::uuid, 'Test Room', 'test', 'general')
      `);

      // Run migration multiple times
      await migrateToEntityRLS(mockAdapter);
      await migrateToEntityRLS(mockAdapter);
      await migrateToEntityRLS(mockAdapter);

      // Verify data is still intact
      const rooms = await db.execute(sql`SELECT * FROM rooms`);
      expect(rooms.rows).toHaveLength(1);
      expect(rooms.rows[0].name).toBe('Test Room');

      // Verify columns are correct
      const roomsColumns = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rooms'
        ORDER BY column_name
      `);
      const roomColumnNames = roomsColumns.rows.map((r: any) => r.column_name);

      expect(roomColumnNames).toContain('agent_id');
      expect(roomColumnNames).toContain('created_at');
    });
  });
});
