import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AgentsService } from '../../services/agents';
import { HttpClient } from '../../http/client';
import { Agent, CreateAgentRequest, UpdateAgentRequest, AgentListResponse } from '../../types/agents';

// Mock the HTTP client
jest.mock('../../http/client');
const mockHttpClient = HttpClient as jest.MockedClass<typeof HttpClient>;

describe('AgentsService', () => {
  let agentsService: AgentsService;
  let mockHttpInstance: jest.Mocked<HttpClient>;

  const mockAgent: Agent = {
    id: 'agent-123',
    name: 'Test Agent',
    description: 'A test agent for unit testing',
    model: 'gpt-4',
    instructions: 'You are a helpful assistant',
    tools: [],
    created_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
    metadata: {},
  };

  const mockCreateRequest: CreateAgentRequest = {
    name: 'New Agent',
    description: 'A new agent',
    model: 'gpt-4',
    instructions: 'Be helpful',
  };

  const mockUpdateRequest: UpdateAgentRequest = {
    name: 'Updated Agent',
    description: 'An updated agent description',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockHttpInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      patch: jest.fn(),
    } as unknown as jest.Mocked<HttpClient>;
    mockHttpClient.mockImplementation(() => mockHttpInstance);
    agentsService = new AgentsService(mockHttpInstance);
  });

  describe('listAgents', () => {
    it('should successfully retrieve a list of agents', async () => {
      const mockResponse: AgentListResponse = {
        data: [mockAgent],
        total: 1,
        page: 1,
        limit: 10,
      };
      mockHttpInstance.get.mockResolvedValue({ data: mockResponse });

      const result = await agentsService.listAgents();

      expect(mockHttpInstance.get).toHaveBeenCalledWith('/agents');
      expect(result).toEqual(mockResponse);
    });

    it('should handle empty agent list', async () => {
      const mockResponse: AgentListResponse = {
        data: [],
        total: 0,
        page: 1,
        limit: 10,
      };
      mockHttpInstance.get.mockResolvedValue({ data: mockResponse });

      const result = await agentsService.listAgents();

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should handle pagination parameters', async () => {
      const mockResponse: AgentListResponse = {
        data: [mockAgent],
        total: 50,
        page: 2,
        limit: 20,
      };
      mockHttpInstance.get.mockResolvedValue({ data: mockResponse });

      const result = await agentsService.listAgents({ page: 2, limit: 20 });

      expect(mockHttpInstance.get).toHaveBeenCalledWith('/agents', {
        params: { page: 2, limit: 20 },
      });
      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
    });

    it('should handle filtering parameters', async () => {
      const mockResponse: AgentListResponse = {
        data: [mockAgent],
        total: 1,
        page: 1,
        limit: 10,
      };
      mockHttpInstance.get.mockResolvedValue({ data: mockResponse });

      await agentsService.listAgents({ model: 'gpt-4', name: 'Test' });

      expect(mockHttpInstance.get).toHaveBeenCalledWith('/agents', {
        params: { model: 'gpt-4', name: 'Test' },
      });
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network error');
      mockHttpInstance.get.mockRejectedValue(networkError);

      await expect(agentsService.listAgents()).rejects.toThrow('Network error');
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/agents');
    });

    it('should handle API errors with status codes', async () => {
      const apiError = { response: { status: 500, data: { message: 'Internal server error' } } };
      mockHttpInstance.get.mockRejectedValue(apiError);

      await expect(agentsService.listAgents()).rejects.toEqual(apiError);
    });
  });

  describe('getAgent', () => {
    it('should successfully retrieve an agent by ID', async () => {
      mockHttpInstance.get.mockResolvedValue({ data: mockAgent });

      const result = await agentsService.getAgent('agent-123');

      expect(mockHttpInstance.get).toHaveBeenCalledWith('/agents/agent-123');
      expect(result).toEqual(mockAgent);
    });

    it('should handle agent not found', async () => {
      const notFoundError = {
        response: { status: 404, data: { message: 'Agent not found' } },
      };
      mockHttpInstance.get.mockRejectedValue(notFoundError);

      await expect(agentsService.getAgent('nonexistent-id')).rejects.toEqual(notFoundError);
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/agents/nonexistent-id');
    });

    it('should validate agent ID parameter', async () => {
      await expect(agentsService.getAgent('')).rejects.toThrow('Agent ID is required');
      expect(mockHttpInstance.get).not.toHaveBeenCalled();
    });

    it('should handle null or undefined agent ID', async () => {
      await expect(agentsService.getAgent(null as any)).rejects.toThrow('Agent ID is required');
      await expect(agentsService.getAgent(undefined as any)).rejects.toThrow('Agent ID is required');
    });

    it('should handle malformed agent response', async () => {
      mockHttpInstance.get.mockResolvedValue({ data: null });

      await expect(agentsService.getAgent('agent-123')).rejects.toThrow('Invalid agent response');
    });
  });

  describe('createAgent', () => {
    it('should successfully create a new agent', async () => {
      mockHttpInstance.post.mockResolvedValue({ data: mockAgent });

      const result = await agentsService.createAgent(mockCreateRequest);

      expect(mockHttpInstance.post).toHaveBeenCalledWith('/agents', mockCreateRequest);
      expect(result).toEqual(mockAgent);
    });

    it('should validate required fields', async () => {
      const invalidRequest = { ...mockCreateRequest, name: '' };

      await expect(agentsService.createAgent(invalidRequest)).rejects.toThrow('Agent name is required');
      expect(mockHttpInstance.post).not.toHaveBeenCalled();
    });

    it('should validate model field', async () => {
      const invalidRequest = { ...mockCreateRequest, model: '' };

      await expect(agentsService.createAgent(invalidRequest)).rejects.toThrow('Model is required');
    });

    it('should handle validation errors from API', async () => {
      const validationError = {
        response: { status: 400, data: { message: 'Invalid request', errors: ['Name already exists'] } },
      };
      mockHttpInstance.post.mockRejectedValue(validationError);

      await expect(agentsService.createAgent(mockCreateRequest)).rejects.toEqual(validationError);
    });

    it('should handle optional fields correctly', async () => {
      const minimalRequest = {
        name: 'Minimal Agent',
        model: 'gpt-3.5-turbo',
      };
      const expectedAgent = { ...mockAgent, ...minimalRequest };
      mockHttpInstance.post.mockResolvedValue({ data: expectedAgent });

      const result = await agentsService.createAgent(minimalRequest);

      expect(mockHttpInstance.post).toHaveBeenCalledWith('/agents', minimalRequest);
      expect(result.name).toBe(minimalRequest.name);
    });

    it('should handle tools array properly', async () => {
      const requestWithTools = {
        ...mockCreateRequest,
        tools: ['code_interpreter', 'retrieval'],
      };
      mockHttpInstance.post.mockResolvedValue({ data: mockAgent });

      await agentsService.createAgent(requestWithTools);

      expect(mockHttpInstance.post).toHaveBeenCalledWith('/agents', requestWithTools);
    });
  });

  describe('updateAgent', () => {
    it('should successfully update an existing agent', async () => {
      const updatedAgent = { ...mockAgent, ...mockUpdateRequest };
      mockHttpInstance.put.mockResolvedValue({ data: updatedAgent });

      const result = await agentsService.updateAgent('agent-123', mockUpdateRequest);

      expect(mockHttpInstance.put).toHaveBeenCalledWith('/agents/agent-123', mockUpdateRequest);
      expect(result).toEqual(updatedAgent);
    });

    it('should validate agent ID', async () => {
      await expect(agentsService.updateAgent('', mockUpdateRequest)).rejects.toThrow('Agent ID is required');
      expect(mockHttpInstance.put).not.toHaveBeenCalled();
    });

    it('should handle partial updates', async () => {
      const partialUpdate = { name: 'Partially Updated Agent' };
      const updatedAgent = { ...mockAgent, ...partialUpdate };
      mockHttpInstance.put.mockResolvedValue({ data: updatedAgent });

      const result = await agentsService.updateAgent('agent-123', partialUpdate);

      expect(mockHttpInstance.put).toHaveBeenCalledWith('/agents/agent-123', partialUpdate);
      expect(result.name).toBe(partialUpdate.name);
    });

    it('should handle agent not found during update', async () => {
      const notFoundError = {
        response: { status: 404, data: { message: 'Agent not found' } },
      };
      mockHttpInstance.put.mockRejectedValue(notFoundError);

      await expect(agentsService.updateAgent('nonexistent-id', mockUpdateRequest)).rejects.toEqual(notFoundError);
    });

    it('should handle empty update request', async () => {
      await expect(agentsService.updateAgent('agent-123', {})).rejects.toThrow('At least one field must be provided for update');
    });

    it('should validate field types in update request', async () => {
      const invalidUpdate = { name: 123 } as any;

      await expect(agentsService.updateAgent('agent-123', invalidUpdate)).rejects.toThrow('Name must be a string');
    });
  });

  describe('deleteAgent', () => {
    it('should successfully delete an agent', async () => {
      mockHttpInstance.delete.mockResolvedValue({ data: { success: true } });

      const result = await agentsService.deleteAgent('agent-123');

      expect(mockHttpInstance.delete).toHaveBeenCalledWith('/agents/agent-123');
      expect(result).toEqual({ success: true });
    });

    it('should validate agent ID', async () => {
      await expect(agentsService.deleteAgent('')).rejects.toThrow('Agent ID is required');
      expect(mockHttpInstance.delete).not.toHaveBeenCalled();
    });

    it('should handle agent not found during deletion', async () => {
      const notFoundError = {
        response: { status: 404, data: { message: 'Agent not found' } },
      };
      mockHttpInstance.delete.mockRejectedValue(notFoundError);

      await expect(agentsService.deleteAgent('nonexistent-id')).rejects.toEqual(notFoundError);
    });

    it('should handle deletion of agent with active sessions', async () => {
      const conflictError = {
        response: { status: 409, data: { message: 'Cannot delete agent with active sessions' } },
      };
      mockHttpInstance.delete.mockRejectedValue(conflictError);

      await expect(agentsService.deleteAgent('agent-123')).rejects.toEqual(conflictError);
    });

    it('should handle authorization errors', async () => {
      const authError = {
        response: { status: 403, data: { message: 'Insufficient permissions' } },
      };
      mockHttpInstance.delete.mockRejectedValue(authError);

      await expect(agentsService.deleteAgent('agent-123')).rejects.toEqual(authError);
    });
  });

  describe('Edge Cases and Integration', () => {
    it('should handle very long agent names', async () => {
      const longName = 'A'.repeat(1000);
      const requestWithLongName = { ...mockCreateRequest, name: longName };

      if (longName.length > 255) {
        await expect(agentsService.createAgent(requestWithLongName)).rejects.toThrow('Name too long');
      } else {
        mockHttpInstance.post.mockResolvedValue({ data: { ...mockAgent, name: longName } });
        const result = await agentsService.createAgent(requestWithLongName);
        expect(result.name).toBe(longName);
      }
    });

    it('should handle special characters in agent names', async () => {
      const specialName = 'Agent with 特殊字符 and émojis 🤖';
      const requestWithSpecialName = { ...mockCreateRequest, name: specialName };
      mockHttpInstance.post.mockResolvedValue({ data: { ...mockAgent, name: specialName } });

      const result = await agentsService.createAgent(requestWithSpecialName);

      expect(result.name).toBe(specialName);
    });

    it('should handle concurrent requests properly', async () => {
      const agent1Promise = agentsService.getAgent('agent-1');
      const agent2Promise = agentsService.getAgent('agent-2');

      mockHttpInstance.get
        .mockResolvedValueOnce({ data: { ...mockAgent, id: 'agent-1' } })
        .mockResolvedValueOnce({ data: { ...mockAgent, id: 'agent-2' } });

      const [result1, result2] = await Promise.all([agent1Promise, agent2Promise]);

      expect(result1.id).toBe('agent-1');
      expect(result2.id).toBe('agent-2');
      expect(mockHttpInstance.get).toHaveBeenCalledTimes(2);
    });

    it('should handle rate limiting', async () => {
      const rateLimitError = {
        response: { status: 429, data: { message: 'Rate limit exceeded' } },
      };
      mockHttpInstance.get.mockRejectedValue(rateLimitError);

      await expect(agentsService.getAgent('agent-123')).rejects.toEqual(rateLimitError);
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'TimeoutError';
      mockHttpInstance.get.mockRejectedValue(timeoutError);

      await expect(agentsService.getAgent('agent-123')).rejects.toThrow('Request timeout');
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });
});