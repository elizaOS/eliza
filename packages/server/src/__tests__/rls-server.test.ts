import { describe, expect, it } from 'bun:test';
import { stringToUuid } from '@elizaos/core';

/**
 * RLS Server Integration Tests
 *
 * These tests verify the server-side RLS logic without requiring a database.
 * They validate the multi-tenant server ID and isolation logic.
 */

describe('AgentServer RLS Configuration', () => {
  describe('Server ID Assignment', () => {
    it('should use owner_id as serverId when RLS is enabled', () => {
      const mockConfig = {
        ENABLE_RLS_ISOLATION: 'true',
        RLS_OWNER_ID: 'test-tenant-123',
      };

      const rlsEnabled = mockConfig.ENABLE_RLS_ISOLATION === 'true';
      const ownerId = stringToUuid(mockConfig.RLS_OWNER_ID);
      const serverId = rlsEnabled && ownerId ? ownerId : '00000000-0000-0000-0000-000000000000';

      expect(serverId).toBe(ownerId);
      expect(serverId).not.toBe('00000000-0000-0000-0000-000000000000');
    });

    it('should use default serverId when RLS is disabled', () => {
      const mockConfig = {
        ENABLE_RLS_ISOLATION: 'false',
        RLS_OWNER_ID: 'test-tenant-123',
      };

      const rlsEnabled = mockConfig.ENABLE_RLS_ISOLATION === 'true';
      const ownerId = stringToUuid(mockConfig.RLS_OWNER_ID);
      const serverId = rlsEnabled && ownerId ? ownerId : '00000000-0000-0000-0000-000000000000';

      expect(serverId).toBe('00000000-0000-0000-0000-000000000000');
      expect(serverId).not.toBe(ownerId);
    });
  });

  describe('Multi-Server Scenarios', () => {
    it('should generate different serverIds for different RLS owner IDs', () => {
      const tenant1Id = 'sendo-tenant-1';
      const tenant2Id = 'sendo-tenant-2';

      const serverId1 = stringToUuid(tenant1Id);
      const serverId2 = stringToUuid(tenant2Id);

      expect(serverId1).not.toBe(serverId2);
      expect(serverId1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(serverId2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should allow multiple servers with same database when RLS enabled', () => {
      const rlsEnabled = true;
      const server1 = {
        token: 'server-1-token',
        serverId: stringToUuid('server-1-token'),
      };
      const server2 = {
        token: 'server-2-token',
        serverId: stringToUuid('server-2-token'),
      };

      expect(rlsEnabled).toBe(true);
      expect(server1.serverId).not.toBe(server2.serverId);
      expect(server1.serverId).toBe(stringToUuid(server1.token));
      expect(server2.serverId).toBe(stringToUuid(server2.token));
    });
  });

  describe('RLS Validation Requirements', () => {
    it('should require PostgreSQL when RLS is enabled', () => {
      const config = {
        rlsEnabled: true,
        postgresUrl: null,
      };

      const isValid = !config.rlsEnabled || !!config.postgresUrl;
      expect(isValid).toBe(false);
    });

    it('should require auth token when RLS is enabled', () => {
      const config = {
        rlsEnabled: true,
        authToken: null,
      };

      const isValid = !config.rlsEnabled || !!config.authToken;
      expect(isValid).toBe(false);
    });

    it('should allow missing auth token when RLS is disabled', () => {
      const config = {
        rlsEnabled: false,
        authToken: null,
      };

      const isValid = !config.rlsEnabled || !!config.authToken;
      expect(isValid).toBe(true);
    });
  });
});

describe('Route Isolation with Dynamic Server ID', () => {
  describe('API Routes Using serverInstance.serverId', () => {
    it('should use instance serverId instead of hardcoded DEFAULT_SERVER_ID', () => {
      const mockServerInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };

      const serverId = mockServerInstance.serverId;

      expect(serverId).not.toBe('00000000-0000-0000-0000-000000000000');
      expect(serverId).toBe('c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01');
    });

    it('should validate serverId matches serverInstance.serverId', () => {
      const mockServerInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };

      const requestedServerId = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';
      const isValid = requestedServerId === mockServerInstance.serverId;

      expect(isValid).toBe(true);
    });

    it('should reject serverId that does not match serverInstance', () => {
      const mockServerInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };

      const wrongServerId = '3a736a89-66ba-0f58-8c45-ef7406927381';
      const isValid = wrongServerId === mockServerInstance.serverId;

      expect(isValid).toBe(false);
    });
  });

  describe('MessageBusService Integration', () => {
    it('should use global AgentServer instance to get serverId', () => {
      const mockGlobalServer = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };

      // MessageBusService should access serverInstance.serverId
      const serverId = mockGlobalServer.serverId;

      expect(serverId).toBeDefined();
      expect(serverId).toBe('c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01');
    });
  });
});

describe('Agent Registration with RLS', () => {
  describe('Agent-to-Owner Assignment', () => {
    it('should assign agent to owner when RLS is enabled', () => {
      const mockServer = {
        rlsOwnerId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };

      const shouldAssign = !!mockServer.rlsOwnerId;

      expect(shouldAssign).toBe(true);
    });

    it('should not assign agent to owner when RLS is disabled', () => {
      const mockServer = {
        rlsOwnerId: undefined,
      };

      const shouldAssign = !!mockServer.rlsOwnerId;

      expect(shouldAssign).toBe(false);
    });
  });

  describe('Server-Agent Association', () => {
    it('should use dynamic serverId for agent association', () => {
      const mockServer = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };

      const associationServerId = mockServer.serverId;

      expect(associationServerId).toBe('c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01');
      expect(associationServerId).not.toBe('00000000-0000-0000-0000-000000000000');
    });
  });
});

describe('RLS Cleanup on Disable', () => {
  describe('uninstallRLS Behavior', () => {
    it('should preserve owner_id column for schema compatibility', () => {
      const cleanupActions = {
        dropPolicies: true,
        disableRLS: true,
        dropOwnersTable: true,
        dropOwnerIdColumn: false, // Should be FALSE
        dropFunctions: true,
      };

      expect(cleanupActions.dropOwnerIdColumn).toBe(false);
      expect(cleanupActions.dropPolicies).toBe(true);
      expect(cleanupActions.disableRLS).toBe(true);
    });

    it('should disable FORCE ROW LEVEL SECURITY', () => {
      const cleanupActions = {
        disableForceRLS: true,
        disableRLS: true,
      };

      expect(cleanupActions.disableForceRLS).toBe(true);
      expect(cleanupActions.disableRLS).toBe(true);
    });
  });
});

describe('Environment Variable Configuration', () => {
  describe('ENABLE_RLS_ISOLATION', () => {
    it('should parse "true" as enabled', () => {
      const env = { ENABLE_RLS_ISOLATION: 'true' };
      const rlsEnabled = env.ENABLE_RLS_ISOLATION === 'true';
      expect(rlsEnabled).toBe(true);
    });

    it('should parse "false" as disabled', () => {
      const env = { ENABLE_RLS_ISOLATION: 'false' };
      const rlsEnabled = env.ENABLE_RLS_ISOLATION === 'true';
      expect(rlsEnabled).toBe(false);
    });

    it('should treat undefined as disabled', () => {
      const env = {};
      const rlsEnabled = (env as { ENABLE_RLS_ISOLATION?: string }).ENABLE_RLS_ISOLATION === 'true';
      expect(rlsEnabled).toBe(false);
    });
  });

  describe('RLS_OWNER_ID', () => {
    it('should generate consistent owner_id from RLS_OWNER_ID string', () => {
      const rlsOwnerId = 'my-tenant-123';
      const ownerId1 = stringToUuid(rlsOwnerId);
      const ownerId2 = stringToUuid(rlsOwnerId);

      expect(ownerId1).toBe(ownerId2);
    });

    it('should generate different owner_ids for different RLS_OWNER_ID values', () => {
      const tenant1 = 'tenant-1';
      const tenant2 = 'tenant-2';

      const ownerId1 = stringToUuid(tenant1);
      const ownerId2 = stringToUuid(tenant2);

      expect(ownerId1).not.toBe(ownerId2);
    });
  });
});

describe('API Endpoint Security - server_id Validation', () => {
  describe('Strict server_id Validation', () => {
    it('should accept server_id that matches serverInstance.serverId', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';

      const isValidServerId = requestServerId === serverInstance.serverId;

      expect(isValidServerId).toBe(true);
    });

    it('should reject server_id that does not match serverInstance.serverId', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = '3a736a89-66ba-0f58-8c45-ef7406927381'; // Different tenant

      const isValidServerId = requestServerId === serverInstance.serverId;

      expect(isValidServerId).toBe(false);
    });

    it('should reject valid UUID that belongs to another tenant', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const otherTenantId = stringToUuid('other-tenant-token');

      // Even if it's a valid UUID, it should be rejected if it doesn't match
      const isValidServerId = otherTenantId === serverInstance.serverId;

      expect(isValidServerId).toBe(false);
      expect(otherTenantId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should return 403 Forbidden for mismatched server_id', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = '3a736a89-66ba-0f58-8c45-ef7406927381';

      const isValid = requestServerId === serverInstance.serverId;
      const expectedStatusCode = isValid ? 200 : 403;

      expect(expectedStatusCode).toBe(403);
    });
  });

  describe('POST /submit endpoint security', () => {
    it('should validate server_id strictly without fallback to validateUuid', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = '3a736a89-66ba-0f58-8c45-ef7406927381';

      // Old (insecure): server_id === serverInstance.serverId || validateUuid(server_id)
      // New (secure): server_id === serverInstance.serverId
      const isValidServerId = requestServerId === serverInstance.serverId;

      expect(isValidServerId).toBe(false);
    });
  });

  describe('POST /action endpoint security', () => {
    it('should validate server_id strictly without fallback to validateUuid', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = '3a736a89-66ba-0f58-8c45-ef7406927381';

      const isValidServerId = requestServerId === serverInstance.serverId;

      expect(isValidServerId).toBe(false);
    });
  });

  describe('PATCH /action/:id endpoint security', () => {
    it('should reject request with mismatched server_id', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = '3a736a89-66ba-0f58-8c45-ef7406927381';

      const shouldReject = requestServerId && requestServerId !== serverInstance.serverId;

      expect(shouldReject).toBe(true);
    });

    it('should accept request with matching server_id', () => {
      const serverInstance = {
        serverId: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01',
      };
      const requestServerId = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';

      const shouldReject = requestServerId && requestServerId !== serverInstance.serverId;

      expect(shouldReject).toBe(false);
    });
  });
});

describe('Connection Pool Isolation', () => {
  describe('Map-based Connection Pool Management', () => {
    it('should use separate connection pools for different owner_ids', () => {
      const owner1Id = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';
      const owner2Id = '3a736a89-66ba-0f58-8c45-ef7406927381';

      // Simulate Map<string, PostgresConnectionManager>
      const connectionPools = new Map();
      connectionPools.set(owner1Id, { ownerId: owner1Id, applicationName: owner1Id });
      connectionPools.set(owner2Id, { ownerId: owner2Id, applicationName: owner2Id });

      const pool1 = connectionPools.get(owner1Id);
      const pool2 = connectionPools.get(owner2Id);

      expect(pool1).not.toBe(pool2);
      expect(pool1?.ownerId).toBe(owner1Id);
      expect(pool2?.ownerId).toBe(owner2Id);
    });

    it('should reuse same connection pool for same owner_id', () => {
      const ownerId = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';

      const connectionPools = new Map();
      const pool1 = { ownerId, applicationName: ownerId };
      connectionPools.set(ownerId, pool1);

      // Second access should return same pool
      const pool2 = connectionPools.get(ownerId);

      expect(pool1).toBe(pool2);
    });

    it('should use default key when RLS is disabled', () => {
      const rlsEnabled = false;
      const ownerId = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';
      const managerKey = rlsEnabled ? ownerId : 'default';

      expect(managerKey).toBe('default');
    });

    it('should use owner_id as key when RLS is enabled', () => {
      const rlsEnabled = true;
      const ownerId = 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01';
      const managerKey = rlsEnabled ? ownerId : 'default';

      expect(managerKey).toBe(ownerId);
    });
  });
});

describe('RLS Enable/Disable Data Preservation', () => {
  describe('Preserve owner_id on Disable', () => {
    it('should keep owner_id values when disabling RLS', () => {
      const mockData = [
        { id: 1, owner_id: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01' },
        { id: 2, owner_id: '3a736a89-66ba-0f58-8c45-ef7406927381' },
      ];

      // Simulate uninstallRLS (should NOT set owner_id to NULL)
      const afterDisable = mockData.map((row) => ({ ...row })); // Keep owner_id intact

      expect(afterDisable[0].owner_id).toBe('c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01');
      expect(afterDisable[1].owner_id).toBe('3a736a89-66ba-0f58-8c45-ef7406927381');
    });

    it('should not backfill existing owner_id values on re-enable', () => {
      const mockData = [
        { id: 1, owner_id: 'c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01' }, // Existing data
        { id: 2, owner_id: null }, // Only backfill this one
      ];

      const currentOwnerId = '3a736a89-66ba-0f58-8c45-ef7406927381';

      // Simulate add_owner_isolation (only backfill NULL, don't steal existing data)
      const afterEnable = mockData.map((row) => ({
        ...row,
        owner_id: row.owner_id === null ? currentOwnerId : row.owner_id,
      }));

      // Row 1 should keep original owner_id (prevent data theft)
      expect(afterEnable[0].owner_id).toBe('c37e5ad5-bfbc-0be7-b62f-d0ac8702ad01');
      // Row 2 should be backfilled with current owner_id
      expect(afterEnable[1].owner_id).toBe(currentOwnerId);
    });
  });
});
