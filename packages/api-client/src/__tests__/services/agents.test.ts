import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentsService } from '../../services/agents';
import { ApiClientConfig } from '../../types/base';
import { UUID } from '@elizaos/core';

// Test UUIDs in proper format
const TEST_AGENT_ID = '550e8400-e29b-41d4-a716-446655440001' as UUID;
const TEST_AGENT_ID_2 = '550e8400-e29b-41d4-a716-446655440002' as UUID;
const TEST_WORLD_ID = '550e8400-e29b-41d4-a716-446655440003' as UUID;
const TEST_LOG_ID = '550e8400-e29b-41d4-a716-446655440004' as UUID;

describe('AgentsService', () => {
  let agentsService: AgentsService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    agentsService = new AgentsService(mockConfig);
    // Mock the HTTP methods
    (agentsService as any).get = mock(() => Promise.resolve({}));
    (agentsService as any).post = mock(() => Promise.resolve({}));
    (agentsService as any).put = mock(() => Promise.resolve({}));
    (agentsService as any).delete = mock(() => Promise.resolve({}));
    (agentsService as any).patch = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const getMock = (agentsService as any).get;
    const postMock = (agentsService as any).post;
    const putMock = (agentsService as any).put;
    const deleteMock = (agentsService as any).delete;
    const patchMock = (agentsService as any).patch;

    if (getMock?.mockClear) getMock.mockClear();
    if (postMock?.mockClear) postMock.mockClear();
    if (putMock?.mockClear) putMock.mockClear();
    if (deleteMock?.mockClear) deleteMock.mockClear();
    if (patchMock?.mockClear) patchMock.mockClear();
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(agentsService).toBeInstanceOf(AgentsService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      expect(() => new AgentsService(null as any)).toThrow();
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
      (agentsService as any).get.mockResolvedValue(mockResponse);

      const result = await agentsService.listAgents();

      expect((agentsService as any).get).toHaveBeenCalledWith('/api/agents');
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
      (agentsService as any).get.mockResolvedValue(mockAgent);

      const result = await agentsService.getAgent(TEST_AGENT_ID);

      expect((agentsService as any).get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}`);
      expect(result).toEqual(mockAgent);
    });

    it('should handle agent not found', async () => {
      (agentsService as any).get.mockRejectedValue(new Error('Agent not found'));

      await expect(agentsService.getAgent(TEST_AGENT_ID)).rejects.toThrow('Agent not found');
    });
  });

  describe('createAgent', () => {
    const createParams = {
      name: 'New Agent',
      description: 'A new agent',
      metadata: { model: 'gpt-4' },
    };

    it('should create agent successfully', async () => {
      const mockResponse = {
        id: TEST_AGENT_ID,
        name: createParams.name,
        description: createParams.description,
        status: 'active' as const,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        metadata: createParams.metadata,
      };
      (agentsService as any).post.mockResolvedValue(mockResponse);

      const result = await agentsService.createAgent(createParams);

      expect((agentsService as any).post).toHaveBeenCalledWith('/api/agents', createParams);
      expect(result).toEqual(mockResponse);
    });

    it('should handle validation errors', async () => {
      (agentsService as any).post.mockRejectedValue(new Error('Validation failed'));

      await expect(agentsService.createAgent(createParams)).rejects.toThrow('Validation failed');
    });
  });

  describe('updateAgent', () => {
    const updateParams = {
      name: 'Updated Agent',
      description: 'Updated description',
    };

    it('should update agent successfully', async () => {
      const mockResponse = {
        id: TEST_AGENT_ID,
        name: updateParams.name,
        description: updateParams.description,
        status: 'active' as const,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };
      (agentsService as any).patch.mockResolvedValue(mockResponse);

      const result = await agentsService.updateAgent(TEST_AGENT_ID, updateParams);

      expect((agentsService as any).patch).toHaveBeenCalledWith(
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
      (agentsService as any).patch.mockResolvedValue(mockResponse);

      await agentsService.updateAgent(TEST_AGENT_ID, partialUpdate);

      expect((agentsService as any).patch).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}`,
        partialUpdate
      );
    });
  });

  describe('deleteAgent', () => {
    it('should delete agent successfully', async () => {
      const mockResponse = { success: true };
      (agentsService as any).delete.mockResolvedValue(mockResponse);

      const result = await agentsService.deleteAgent(TEST_AGENT_ID);

      expect((agentsService as any).delete).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}`);
      expect(result).toEqual(mockResponse);
    });

    it('should handle deletion errors', async () => {
      (agentsService as any).delete.mockRejectedValue(new Error('Deletion failed'));

      await expect(agentsService.deleteAgent(TEST_AGENT_ID)).rejects.toThrow('Deletion failed');
    });
  });

  describe('startAgent', () => {
    it('should start agent successfully', async () => {
      const mockResponse = { status: 'starting' };
      (agentsService as any).post.mockResolvedValue(mockResponse);

      const result = await agentsService.startAgent(TEST_AGENT_ID);

      expect((agentsService as any).post).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}/start`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('stopAgent', () => {
    it('should stop agent successfully', async () => {
      const mockResponse = { status: 'stopped' };
      (agentsService as any).post.mockResolvedValue(mockResponse);

      const result = await agentsService.stopAgent(TEST_AGENT_ID);

      expect((agentsService as any).post).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/stop`);
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
      (agentsService as any).get.mockResolvedValue(mockResponse);

      const result = await agentsService.getWorlds();

      expect((agentsService as any).get).toHaveBeenCalledWith('/api/agents/worlds');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('addAgentToWorld', () => {
    it('should add agent to world successfully', async () => {
      const mockResponse = { success: true };
      (agentsService as any).post.mockResolvedValue(mockResponse);

      const result = await agentsService.addAgentToWorld(TEST_AGENT_ID, TEST_WORLD_ID);

      expect((agentsService as any).post).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}/worlds`,
        { worldId: TEST_WORLD_ID }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateAgentWorldSettings', () => {
    const settings = { setting1: 'value1' };

    it('should update agent world settings successfully', async () => {
      const mockResponse = { worldId: TEST_WORLD_ID, settings };
      (agentsService as any).patch.mockResolvedValue(mockResponse);

      const result = await agentsService.updateAgentWorldSettings(
        TEST_AGENT_ID,
        TEST_WORLD_ID,
        settings
      );

      expect((agentsService as any).patch).toHaveBeenCalledWith(
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
      (agentsService as any).get.mockResolvedValue(mockApiResponse);

      const result = await agentsService.getAgentPanels(TEST_AGENT_ID);

      expect((agentsService as any).get).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}/panels`
      );
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
          timestamp: new Date('2024-01-01T00:00:00Z'),
          level: 'info' as const,
          message: 'Agent started',
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440006' as UUID,
          agentId: TEST_AGENT_ID,
          timestamp: new Date('2024-01-01T00:01:00Z'),
          level: 'debug' as const,
          message: 'Processing message',
        },
      ];
      (agentsService as any).get.mockResolvedValue(mockLogs);

      const result = await agentsService.getAgentLogs(TEST_AGENT_ID);

      expect((agentsService as any).get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/logs`, {
        params: undefined,
      });
      expect(result).toEqual(mockLogs);
    });

    it('should handle log parameters', async () => {
      const params = { limit: 100, level: 'error' as const };
      (agentsService as any).get.mockResolvedValue([]);

      await agentsService.getAgentLogs(TEST_AGENT_ID, params);

      expect((agentsService as any).get).toHaveBeenCalledWith(`/api/agents/${TEST_AGENT_ID}/logs`, {
        params,
      });
    });
  });

  describe('deleteAgentLog', () => {
    it('should delete agent log successfully', async () => {
      const mockResponse = { success: true };
      (agentsService as any).delete.mockResolvedValue(mockResponse);

      const result = await agentsService.deleteAgentLog(TEST_AGENT_ID, TEST_LOG_ID);

      expect((agentsService as any).delete).toHaveBeenCalledWith(
        `/api/agents/${TEST_AGENT_ID}/logs/${TEST_LOG_ID}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      (agentsService as any).get.mockRejectedValue(new Error('Network error'));

      await expect(agentsService.listAgents()).rejects.toThrow('Network error');
    });

    it('should handle API errors', async () => {
      (agentsService as any).post.mockRejectedValue(new Error('API error'));

      await expect(agentsService.createAgent({ name: 'test' })).rejects.toThrow('API error');
    });

    it('should handle unauthorized errors', async () => {
      (agentsService as any).get.mockRejectedValue(new Error('Unauthorized'));

      await expect(agentsService.getAgent(TEST_AGENT_ID)).rejects.toThrow('Unauthorized');
    });

    it('should handle rate limiting', async () => {
      (agentsService as any).get.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(agentsService.listAgents()).rejects.toThrow('Rate limit exceeded');
    });
  });
});
