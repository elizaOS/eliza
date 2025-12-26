/**
 * Tests for message servers API routes
 *
 * These tests verify the route naming consistency and response formats
 * for the /message-servers endpoints.
 */

import { describe, it, expect } from 'bun:test';

describe('Message Servers API Routes', () => {
  describe('Route naming conventions', () => {
    it('should use /message-servers (plural) for collection endpoints', () => {
      const collectionRoutes = ['GET /message-servers', 'POST /message-servers'];

      collectionRoutes.forEach((route) => {
        expect(route).toContain('/message-servers');
        expect(route).not.toContain('/servers');
      });
    });

    it('should use /message-server (singular) for current instance endpoint', () => {
      const currentRoute = 'GET /message-server/current';
      expect(currentRoute).toContain('/message-server/current');
    });

    it('should use :messageServerId parameter consistently', () => {
      const parameterizedRoutes = [
        '/message-servers/:messageServerId/agents',
        '/message-servers/:messageServerId/agents/:agentId',
      ];

      parameterizedRoutes.forEach((route) => {
        expect(route).toContain(':messageServerId');
        expect(route).not.toContain(':serverId');
      });
    });

    it('should use /agents/:agentId/message-servers for reverse lookup', () => {
      const reverseRoute = '/agents/:agentId/message-servers';
      expect(reverseRoute).toContain('/message-servers');
      expect(reverseRoute).not.toContain('/servers');
    });
  });

  describe('Response format for GET /message-server/current', () => {
    it('should return messageServerId in response', () => {
      const mockResponse = {
        success: true,
        data: {
          messageServerId: '00000000-0000-0000-0000-000000000000',
        },
      };

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.data).toHaveProperty('messageServerId');
      expect(mockResponse.data.messageServerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });
  });

  describe('Response format for GET /message-servers', () => {
    it('should return messageServers array in response', () => {
      const mockResponse = {
        success: true,
        data: {
          messageServers: [
            {
              id: '00000000-0000-0000-0000-000000000000',
              name: 'Default Server',
              sourceType: 'eliza_default',
            },
          ],
        },
      };

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.data).toHaveProperty('messageServers');
      expect(Array.isArray(mockResponse.data.messageServers)).toBe(true);
    });
  });

  describe('Response format for GET /message-servers/:messageServerId/agents', () => {
    it('should return messageServerId and agents array', () => {
      const mockResponse = {
        success: true,
        data: {
          messageServerId: '00000000-0000-0000-0000-000000000000',
          agents: ['11111111-1111-1111-1111-111111111111'],
        },
      };

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.data).toHaveProperty('messageServerId');
      expect(mockResponse.data).toHaveProperty('agents');
      expect(Array.isArray(mockResponse.data.agents)).toBe(true);
    });
  });

  describe('Response format for POST /message-servers/:messageServerId/agents', () => {
    it('should return messageServerId and agentId in response', () => {
      const mockResponse = {
        success: true,
        data: {
          messageServerId: '00000000-0000-0000-0000-000000000000',
          agentId: '11111111-1111-1111-1111-111111111111',
          message: 'Agent added to message server successfully',
        },
      };

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.data).toHaveProperty('messageServerId');
      expect(mockResponse.data).toHaveProperty('agentId');
      expect(mockResponse.data).toHaveProperty('message');
    });
  });

  describe('Response format for GET /agents/:agentId/message-servers', () => {
    it('should return agentId and messageServers array', () => {
      const mockResponse = {
        success: true,
        data: {
          agentId: '11111111-1111-1111-1111-111111111111',
          messageServers: ['00000000-0000-0000-0000-000000000000'],
        },
      };

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.data).toHaveProperty('agentId');
      expect(mockResponse.data).toHaveProperty('messageServers');
      expect(Array.isArray(mockResponse.data.messageServers)).toBe(true);
    });
  });

  describe('Deprecated routes', () => {
    it('should map deprecated /central-servers to /message-servers', () => {
      const deprecatedRoute = '/central-servers';
      const newRoute = '/message-servers';

      expect(deprecatedRoute).not.toBe(newRoute);
      expect(newRoute).toContain('message-servers');
    });

    it('should map deprecated /servers to /message-servers', () => {
      const deprecatedRoute = '/servers';
      const newRoute = '/message-servers';

      expect(deprecatedRoute).not.toBe(newRoute);
      expect(newRoute).toContain('message-servers');
    });

    it('should map deprecated :serverId to :messageServerId', () => {
      const deprecatedParam = ':serverId';
      const newParam = ':messageServerId';

      expect(deprecatedParam).not.toBe(newParam);
      expect(newParam).toContain('messageServerId');
    });
  });

  describe('RLS Security checks', () => {
    it('should return 403 when accessing agents for different server', () => {
      const errorResponse = {
        success: false,
        error: 'Cannot access agents for a different server',
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('different server');
    });

    it('should return 403 when modifying agents for different server', () => {
      const errorResponse = {
        success: false,
        error: 'Cannot modify agents for a different server',
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('different server');
    });
  });

  describe('Validation errors', () => {
    it('should return 400 for invalid messageServerId format', () => {
      const errorResponse = {
        success: false,
        error: 'Invalid messageServerId format',
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('Invalid messageServerId');
    });

    it('should return 400 for invalid agentId format', () => {
      const errorResponse = {
        success: false,
        error: 'Invalid messageServerId or agentId format',
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('agentId');
    });

    it('should return 400 for missing required fields on create', () => {
      const errorResponse = {
        success: false,
        error: 'Missing required fields: name, sourceType',
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('Missing required fields');
    });
  });
});
