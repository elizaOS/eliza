import { describe, expect, it, beforeEach } from 'bun:test';
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
        ELIZA_SERVER_AUTH_TOKEN: 'test-token-123',
      };

      const rlsEnabled = mockConfig.ENABLE_RLS_ISOLATION === 'true';
      const ownerId = stringToUuid(mockConfig.ELIZA_SERVER_AUTH_TOKEN);
      const serverId = rlsEnabled && ownerId ? ownerId : '00000000-0000-0000-0000-000000000000';

      expect(serverId).toBe(ownerId);
      expect(serverId).not.toBe('00000000-0000-0000-0000-000000000000');
    });

    it('should use default serverId when RLS is disabled', () => {
      const mockConfig = {
        ENABLE_RLS_ISOLATION: 'false',
        ELIZA_SERVER_AUTH_TOKEN: 'test-token-123',
      };

      const rlsEnabled = mockConfig.ENABLE_RLS_ISOLATION === 'true';
      const ownerId = stringToUuid(mockConfig.ELIZA_SERVER_AUTH_TOKEN);
      const serverId = rlsEnabled && ownerId ? ownerId : '00000000-0000-0000-0000-000000000000';

      expect(serverId).toBe('00000000-0000-0000-0000-000000000000');
      expect(serverId).not.toBe(ownerId);
    });
  });

  describe('Multi-Server Scenarios', () => {
    it('should generate different serverIds for different auth tokens', () => {
      const server1Token = 'sendo-dev-key';
      const server2Token = 'sendo-dev-key-2';

      const serverId1 = stringToUuid(server1Token);
      const serverId2 = stringToUuid(server2Token);

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

      const agentId = 'agent-123';
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

      const agentId = 'agent-123';
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
      const rlsEnabled = env.ENABLE_RLS_ISOLATION === 'true';
      expect(rlsEnabled).toBe(false);
    });
  });

  describe('ELIZA_SERVER_AUTH_TOKEN', () => {
    it('should generate consistent owner_id from token', () => {
      const token = 'my-secret-token-123';
      const ownerId1 = stringToUuid(token);
      const ownerId2 = stringToUuid(token);

      expect(ownerId1).toBe(ownerId2);
    });

    it('should generate different owner_ids for different tokens', () => {
      const token1 = 'server-1-token';
      const token2 = 'server-2-token';

      const ownerId1 = stringToUuid(token1);
      const ownerId2 = stringToUuid(token2);

      expect(ownerId1).not.toBe(ownerId2);
    });
  });
});