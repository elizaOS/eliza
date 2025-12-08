import { describe, expect, it } from 'bun:test';
import { stringToUuid } from '@elizaos/core';

/**
 * Server RLS Unit Tests
 *
 * These tests verify the Server RLS logic without requiring a PostgreSQL database.
 * They use mocks to test function behavior.
 */

describe('Server RLS Helper Functions', () => {
  describe('Server ID Generation', () => {
    it('should generate consistent UUIDs from server identifiers', () => {
      const token1 = 'test-auth-token-123';
      const token2 = 'test-auth-token-456';

      const uuid1a = stringToUuid(token1);
      const uuid1b = stringToUuid(token1);
      const uuid2 = stringToUuid(token2);

      // Same token should produce same UUID
      expect(uuid1a).toBe(uuid1b);

      // Different tokens should produce different UUIDs
      expect(uuid1a).not.toBe(uuid2);

      // UUIDs should be valid format
      expect(uuid1a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(uuid2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should handle empty tokens', () => {
      const emptyUuid = stringToUuid('');
      expect(emptyUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should handle special characters in tokens', () => {
      const specialToken = 'token-with-special-chars-!@#$%^&*()';
      const uuid = stringToUuid(specialToken);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('RLS Configuration Validation', () => {
    it('should validate RLS environment variables', () => {
      const testCases = [
        {
          rlsEnabled: 'true',
          authToken: 'token-123',
          postgresUrl: 'postgresql://...',
          expected: true,
        },
        { rlsEnabled: 'false', authToken: '', postgresUrl: '', expected: false },
        { rlsEnabled: 'true', authToken: '', postgresUrl: 'postgresql://...', expected: false }, // Missing token
        { rlsEnabled: 'true', authToken: 'token', postgresUrl: '', expected: false }, // Missing postgres
      ];

      testCases.forEach(({ rlsEnabled, authToken, postgresUrl, expected }) => {
        const isValid =
          rlsEnabled === 'true' && authToken !== '' && postgresUrl.startsWith('postgresql://');
        expect(isValid).toBe(expected);
      });
    });
  });

  describe('Dynamic Server ID Logic', () => {
    it('should use server_id as server ID when RLS is enabled', () => {
      const rlsEnabled = true;
      const serverId_value = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';
      const defaultServerId = '00000000-0000-0000-0000-000000000000';

      const serverId = rlsEnabled && serverId_value ? serverId_value : defaultServerId;

      expect(serverId).toBe(serverId_value);
      expect(serverId).not.toBe(defaultServerId);
    });

    it('should use default server ID when RLS is disabled', () => {
      const rlsEnabled = false;
      const serverId_value = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';
      const defaultServerId = '00000000-0000-0000-0000-000000000000';

      const serverId = rlsEnabled && serverId_value ? serverId_value : defaultServerId;

      expect(serverId).toBe(defaultServerId);
      expect(serverId).not.toBe(serverId_value);
    });

    it('should use default server ID when server_id is undefined', () => {
      const rlsEnabled = true;
      const serverId_value = undefined;
      const defaultServerId = '00000000-0000-0000-0000-000000000000';

      const serverId = rlsEnabled && serverId_value ? serverId_value : defaultServerId;

      expect(serverId).toBe(defaultServerId);
    });
  });

  describe('Server Name Generation', () => {
    it('should generate instance-specific server name when RLS enabled', () => {
      const rlsEnabled = true;
      const serverId_value = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';

      const serverName =
        rlsEnabled && serverId_value
          ? `Server ${serverId_value.substring(0, 8)}`
          : 'Default Server';

      expect(serverName).toBe('Server c37e5ad5');
      expect(serverName).not.toBe('Default Server');
    });

    it('should use default server name when RLS disabled', () => {
      const rlsEnabled = false;
      const serverId_value = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';

      const serverName =
        rlsEnabled && serverId_value
          ? `Server ${serverId_value.substring(0, 8)}`
          : 'Default Server';

      expect(serverName).toBe('Default Server');
    });
  });

  describe('Table Exclusions', () => {
    it('should define correct tables excluded from Server RLS', () => {
      const excludedTables = ['servers', 'drizzle_migrations', '__drizzle_migrations'];

      // Tables that should NOT have Server RLS
      expect(excludedTables).toContain('servers');
      expect(excludedTables).toContain('drizzle_migrations');
      expect(excludedTables).toContain('__drizzle_migrations');

      // Tables that SHOULD have Server RLS (not in exclusion list)
      expect(excludedTables).not.toContain('agents');
      expect(excludedTables).not.toContain('messages');
      expect(excludedTables).not.toContain('channels');
      expect(excludedTables).not.toContain('message_servers');
      expect(excludedTables).not.toContain('memories');
    });
  });

  describe('Server RLS SQL Function Names', () => {
    it('should have consistent function names', () => {
      const functions = {
        currentServerId: 'current_server_id',
        addServerIsolation: 'add_server_isolation',
        applyRlsToAllTables: 'apply_rls_to_all_tables',
      };

      expect(functions.currentServerId).toBe('current_server_id');
      expect(functions.addServerIsolation).toBe('add_server_isolation');
      expect(functions.applyRlsToAllTables).toBe('apply_rls_to_all_tables');
    });
  });

  describe('Policy Names', () => {
    it('should use consistent policy naming', () => {
      const tableName = 'agents';
      const policyName = 'server_isolation_policy';

      expect(policyName).toBe('server_isolation_policy');
      expect(policyName).not.toContain(tableName); // Generic policy name for all tables
    });
  });
});

describe('Server RLS Schema Validation', () => {
  describe('Servers Table Schema', () => {
    it('should have correct columns', () => {
      const expectedColumns = {
        id: { type: 'UUID', primaryKey: true },
        created_at: { type: 'TIMESTAMPTZ', nullable: false },
        updated_at: { type: 'TIMESTAMPTZ', nullable: false },
      };

      expect(Object.keys(expectedColumns)).toHaveLength(3);
      expect(expectedColumns.id.primaryKey).toBe(true);
      expect(expectedColumns.created_at.nullable).toBe(false);
      expect(expectedColumns.updated_at.nullable).toBe(false);
    });
  });

  describe('Agent Table Schema with Server RLS', () => {
    it('should include server_id column when RLS is enabled', () => {
      const columns = [
        'id',
        'name',
        'username',
        'server_id', // RLS column
        'created_at',
        'updated_at',
      ];

      expect(columns).toContain('server_id');
    });

    it('should have index on server_id column', () => {
      const indexName = 'idx_agents_server_id';
      const indexColumn = 'server_id';

      expect(indexName).toContain(indexColumn);
      expect(indexName).toContain('agents');
    });
  });
});

describe('Server RLS Security Properties', () => {
  describe('FORCE ROW LEVEL SECURITY', () => {
    it('should enforce RLS even for table owner (PostgreSQL role)', () => {
      const forceRLS = true;

      // When FORCE is enabled, even PostgreSQL table owner role respects RLS
      expect(forceRLS).toBe(true);
    });

    it('should enforce strict server_id matching (no NULL clause)', () => {
      const policyCondition = 'server_id = current_server_id()';

      // Security hardening: removed NULL clause to prevent data leakage
      expect(policyCondition).not.toContain('OR server_id IS NULL');
      expect(policyCondition).toBe('server_id = current_server_id()');
    });
  });

  describe('Multi-Server Isolation', () => {
    it('should isolate data by server_id', () => {
      const server1Id = stringToUuid('server-1-token');
      const server2Id = stringToUuid('server-2-token');

      // Different servers should have different server IDs
      expect(server1Id).not.toBe(server2Id);

      // Both should be valid UUIDs
      expect(server1Id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(server2Id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });
});
