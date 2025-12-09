import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentsService } from '../../services/agents';
import { ApiClientConfig } from '../../types/base';
import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../../lib/base-client';

// Helper type to access protected methods in tests
type MockableAgentsService = AgentsService & {
  get: ReturnType<typeof mock>;
  post: ReturnType<typeof mock>;
  put: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
  patch: ReturnType<typeof mock>;
};

// Test UUIDs in proper format
const TEST_AGENT_ID = '550e8400-e29b-41d4-a716-446655440001' as UUID;
const TEST_AGENT_ID_2 = '550e8400-e29b-41d4-a716-446655440002' as UUID;
const TEST_WORLD_ID = '550e8400-e29b-41d4-a716-446655440003' as UUID;
const TEST_LOG_ID = '550e8400-e29b-41d4-a716-446655440004' as UUID;

describe('AgentsService', () => {
  let agentsService: MockableAgentsService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    agentsService = new AgentsService(mockConfig) as MockableAgentsService;
    // Mock the HTTP methods
    agentsService.get = mock(() => Promise.resolve({}));
    agentsService.post = mock(() => Promise.resolve({}));
    agentsService.put = mock(() => Promise.resolve({}));
    agentsService.delete = mock(() => Promise.resolve({}));
    agentsService.patch = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const getMock = agentsService.get;
    const postMock = agentsService.post;
    const putMock = agentsService.put;
    const deleteMock = agentsService.delete;
    const patchMock = agentsService.patch;

    if (getMock?.mockClear) {
      getMock.mockClear();
    }
    if (postMock?.mockClear) {
      postMock.mockClear();
    }
    if (putMock?.mockClear) {
      putMock.mockClear();
    }
    if (deleteMock?.mockClear) {
      deleteMock.mockClear();
    }
    if (patchMock?.mockClear) {
      patchMock.mockClear();
    }
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(agentsService).toBeInstanceOf(AgentsService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      // Testing error handling with null config
      expect(() => new AgentsService(null as ApiClientConfig)).toThrow();
    });
  });

  describe('listAgents', () => {
    it('should retrieve agents list successfully', async () => {
      const mockResponse = {
        agents: [
          {
            id: TEST_AGENT_ID,
            name: 'Agent 1',
            status: 'active' as const,
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          },
          {
            id: TEST_AGENT_ID_2,
            name: 'Agent 2',
            status: 'inactive' as const,
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
      };
      agentsService.get.mockResolvedValue(mockResponse);

      const result = await agentsService.listAgents();

      expect(agentsService.get).toHaveBeenCalledWith('/api/agents');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getAgent', () => {
    it('should retrieve agent successfully', async () => {
      const mockAgent = {
        id: TEST_AGENT_ID,
        name: 'Test Agent',
        status: 'active' as const,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      agentsService.get.mockResolvedValue(mockAgent);

      const result = await agentsService.getAgent(TEST_AGENT_ID);

      expect(agentsService.get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}`);
      expect(result).toEqual(mockAgent);
    });

    it('should handle agent not found', async () => {
      agentsService.get.mockRejectedValue(new Error('Agent not found'));

      await expect(agentsService.getAgent(TEST_AGENT_ID)).rejects.toThrow('Agent not found');
    });
  });

  describe('createAgent', () => {
    const createParams = {
      agent: {
        name: 'New Agent',
        bio: 'A new agent',
        metadata: { model: 'gpt-4' },
      },
    };

    it('should create agent successfully', async () => {
      const mockResponse = {
        id: TEST_AGENT_ID,
        name: createParams.agent.name,
        bio: createParams.agent.bio,
        status: 'active' as const,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        metadata: createParams.agent.metadata,
      };
      agentsService.post.mockResolvedValue(mockResponse);

      const result = await agentsService.createAgent(createParams);

      expect(agentsService.post).toHaveBeenCalledWith('/api/agents', createParams);
      expect(result).toEqual(mockResponse);
    });

    it('should handle validation errors', async () => {
      agentsService.post.mockRejectedValue(new Error('Validation failed'));

      await expect(agentsService.createAgent(createParams)).rejects.toThrow('Validation failed');
    });
  });

  describe('updateAgent', () => {
    const updateParams = {
      name: 'Updated Agent',
      bio: 'Updated bio',
    };

    it('should update agent successfully', async () => {
      const mockResponse = {
        id: TEST_AGENT_ID,
        name: updateParams.name,
        bio: updateParams.bio,
        status: 'active' as const,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      agentsService.patch.mockResolvedValue(mockResponse);

      const result = await agentsService.updateAgent(TEST_AGENT_ID, updateParams);

      expect(agentsService.patch).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}`,
        updateParams
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle partial updates', async () => {
      const partialUpdate = { name: 'New Name' };
      const mockResponse = {
        id: TEST_AGENT_ID,
        name: partialUpdate.name,
        status: 'active' as const,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      agentsService.patch.mockResolvedValue(mockResponse);

      await agentsService.updateAgent(TEST_AGENT_ID, partialUpdate);

      expect(agentsService.patch).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}`,
        partialUpdate
      );
    });
  });

  describe('deleteAgent', () => {
    it('should delete agent successfully', async () => {
      const mockResponse = { success: true };
      agentsService.delete.mockResolvedValue(mockResponse);

      const result = await agentsService.deleteAgent(TEST_AGENT_ID);

      expect(agentsService.delete).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}`);
      expect(result).toEqual(mockResponse);
    });

    it('should handle deletion errors', async () => {
      agentsService.delete.mockRejectedValue(new Error('Deletion failed'));

      await expect(agentsService.deleteAgent(TEST_AGENT_ID)).rejects.toThrow('Deletion failed');
    });
  });

  describe('startAgent', () => {
    it('should start agent successfully', async () => {
      const mockResponse = { status: 'starting' };
      agentsService.post.mockResolvedValue(mockResponse);

      const result = await agentsService.startAgent(TEST_AGENT_ID);

      expect(agentsService.post).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/start`);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('stopAgent', () => {
    it('should stop agent successfully', async () => {
      const mockResponse = { status: 'stopped' };
      agentsService.post.mockResolvedValue(mockResponse);

      const result = await agentsService.stopAgent(TEST_AGENT_ID);

      expect(agentsService.post).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/stop`);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getWorlds', () => {
    it('should get worlds successfully', async () => {
      const mockResponse = {
        worlds: [
          { id: TEST_WORLD_ID, name: 'World 1' },
          { id: '550e8400-e29b-41d4-a716-446655440005' as UUID, name: 'World 2' },
        ],
      };
      agentsService.get.mockResolvedValue(mockResponse);

      const result = await agentsService.getWorlds();

      expect(agentsService.get).toHaveBeenCalledWith('/api/agents/worlds');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('addAgentToWorld', () => {
    it('should add agent to world successfully', async () => {
      const mockResponse = { success: true };
      agentsService.post.mockResolvedValue(mockResponse);

      const result = await agentsService.addAgentToWorld(TEST_AGENT_ID, TEST_WORLD_ID);

      expect(agentsService.post).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/worlds`, {
        worldId: TEST_WORLD_ID,
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateAgentWorldSettings', () => {
    const settings = { setting1: 'value1' };

    it('should update agent world settings successfully', async () => {
      const mockResponse = { worldId: TEST_WORLD_ID, settings };
      agentsService.patch.mockResolvedValue(mockResponse);

      const result = await agentsService.updateAgentWorldSettings(
        TEST_AGENT_ID,
        TEST_WORLD_ID,
        settings
      );

      expect(agentsService.patch).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}/worlds/${TEST_WORLD_ID}`,
        { settings }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getAgentPanels', () => {
    it('should get agent panels successfully', async () => {
      const mockApiResponse = [
        { name: 'Panel 1', path: '/panel1' },
        { name: 'Panel 2', path: '/panel2' },
      ];
      agentsService.get.mockResolvedValue(mockApiResponse);

      const result = await agentsService.getAgentPanels(TEST_AGENT_ID);

      expect(agentsService.get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/panels`);
      expect(result).toEqual({
        panels: [
          { id: 'Panel 1-0', name: 'Panel 1', url: '/panel1', type: 'plugin' },
          { id: 'Panel 2-1', name: 'Panel 2', url: '/panel2', type: 'plugin' },
        ],
      });
    });
  });

  describe('getAgentLogs', () => {
    it('should get agent logs successfully', async () => {
      const mockLogs = [
        {
          id: TEST_LOG_ID,
          agentId: TEST_AGENT_ID,
          timestamp: new Date('2024-01-01T00:00:00Z').getTime(),
          level: 'info' as const,
          message: 'Agent started',
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440006' as UUID,
          agentId: TEST_AGENT_ID,
          timestamp: new Date('2024-01-01T00:01:00Z').getTime(),
          level: 'debug' as const,
          message: 'Processing message',
        },
      ];
      agentsService.get.mockResolvedValue(mockLogs);

      const result = await agentsService.getAgentLogs(TEST_AGENT_ID);

      expect(agentsService.get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/logs`, {
        params: undefined,
      });
      expect(result).toEqual(mockLogs);
    });

    it('should handle log parameters', async () => {
      const params = { limit: 100, level: 'error' as const };
      agentsService.get.mockResolvedValue([]);

      await agentsService.getAgentLogs(TEST_AGENT_ID, params);

      expect(agentsService.get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/logs`, {
        params,
      });
    });
  });

  describe('deleteAgentLog', () => {
    it('should delete agent log successfully', async () => {
      const mockResponse = { success: true };
      agentsService.delete.mockResolvedValue(mockResponse);

      const result = await agentsService.deleteAgentLog(TEST_AGENT_ID, TEST_LOG_ID);

      expect(agentsService.delete).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}/logs/${TEST_LOG_ID}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      agentsService.get.mockRejectedValue(new Error('Network error'));

      await expect(agentsService.listAgents()).rejects.toThrow('Network error');
    });

    it('should handle API errors', async () => {
      agentsService.post.mockRejectedValue(new Error('API error'));

      await expect(
        agentsService.createAgent({ agent: { name: 'test', bio: 'test agent' } })
      ).rejects.toThrow('API error');
    });

    it('should handle unauthorized errors', async () => {
      agentsService.get.mockRejectedValue(new Error('Unauthorized'));

      await expect(agentsService.getAgent(TEST_AGENT_ID)).rejects.toThrow('Unauthorized');
    });

    it('should handle rate limiting', async () => {
      agentsService.get.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(agentsService.listAgents()).rejects.toThrow('Rate limit exceeded');
    });
  });
});
