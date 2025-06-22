import { MemoryService } from '../../services/memory';
import { ApiClient } from '../../api-client';
import {
  Memory,
  CreateMemoryRequest,
  UpdateMemoryRequest,
  MemoryResponse
} from '../../types/memory';

// Mock the API client
jest.mock('../../api-client');
const mockApiClient = jest.mocked(ApiClient);

describe('MemoryService', () => {
  let memoryService: MemoryService;
  let mockApiClientInstance: jest.Mocked<ApiClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApiClientInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      patch: jest.fn(),
    } as any;
    mockApiClient.mockImplementation(() => mockApiClientInstance);
    memoryService = new MemoryService(mockApiClientInstance);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Test data factories
  const createValidMemory = (): Memory => ({
    id: 'mem_123',
    userId: 'user_456',
    content: 'This is a test memory',
    tags: ['test', 'example'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    importance: 5,
    context: 'Test context',
  });

  const createValidCreateRequest = (): CreateMemoryRequest => ({
    userId: 'user_456',
    content: 'New memory content',
    tags: ['new', 'test'],
    importance: 3,
    context: 'New memory context',
  });

  const createValidUpdateRequest = (): UpdateMemoryRequest => ({
    content: 'Updated memory content',
    tags: ['updated', 'test'],
    importance: 4,
    context: 'Updated context',
  });

  const createApiResponse = <T>(data: T): MemoryResponse<T> => ({
    data,
    success: true,
    message: 'Success',
  });

  describe('createMemory', () => {
    it('should create a new memory successfully', async () => {
      const createRequest = createValidCreateRequest();
      const expectedMemory = createValidMemory();
      const apiResponse = createApiResponse(expectedMemory);

      mockApiClientInstance.post.mockResolvedValue(apiResponse);

      const result = await memoryService.createMemory(createRequest);

      expect(mockApiClientInstance.post).toHaveBeenCalledWith('/memories', createRequest);
      expect(result).toEqual(expectedMemory);
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should handle validation errors when creating memory', async () => {
      const invalidRequest = { ...createValidCreateRequest(), userId: '' };

      mockApiClientInstance.post.mockRejectedValue(new Error('Validation failed: userId is required'));

      await expect(memoryService.createMemory(invalidRequest)).rejects.toThrow(
        'Validation failed: userId is required'
      );
      expect(mockApiClientInstance.post).toHaveBeenCalledWith('/memories', invalidRequest);
    });

    it('should handle network errors during memory creation', async () => {
      const createRequest = createValidCreateRequest();

      mockApiClientInstance.post.mockRejectedValue(new Error('Network error'));

      await expect(memoryService.createMemory(createRequest)).rejects.toThrow('Network error');
    });

    it('should create memory with minimal required fields', async () => {
      const minimalRequest: CreateMemoryRequest = {
        userId: 'user_456',
        content: 'Minimal content',
      };
      const expectedMemory = {
        ...createValidMemory(),
        content: 'Minimal content',
        tags: [],
        importance: 1,
      };

      mockApiClientInstance.post.mockResolvedValue(createApiResponse(expectedMemory));

      const result = await memoryService.createMemory(minimalRequest);

      expect(result.content).toBe('Minimal content');
      expect(result.tags).toEqual([]);
    });

    it('should handle empty content gracefully', async () => {
      const emptyContentRequest = { ...createValidCreateRequest(), content: '' };

      mockApiClientInstance.post.mockRejectedValue(new Error('Content cannot be empty'));

      await expect(memoryService.createMemory(emptyContentRequest)).rejects.toThrow(
        'Content cannot be empty'
      );
    });

    it('should handle very large content', async () => {
      const largeContent = 'a'.repeat(10000);
      const largeContentRequest = { ...createValidCreateRequest(), content: largeContent };
      const expectedMemory = { ...createValidMemory(), content: largeContent };

      mockApiClientInstance.post.mockResolvedValue(createApiResponse(expectedMemory));

      const result = await memoryService.createMemory(largeContentRequest);

      expect(result.content).toBe(largeContent);
      expect(result.content.length).toBe(10000);
    });
  });

  describe('getMemory', () => {
    it('should retrieve memory by ID successfully', async () => {
      const memoryId = 'mem_123';
      const expectedMemory = createValidMemory();

      mockApiClientInstance.get.mockResolvedValue(createApiResponse(expectedMemory));

      const result = await memoryService.getMemory(memoryId);

      expect(mockApiClientInstance.get).toHaveBeenCalledWith(`/memories/${memoryId}`);
      expect(result).toEqual(expectedMemory);
    });

    it('should return null for non-existent memory', async () => {
      const memoryId = 'non_existent';

      mockApiClientInstance.get.mockRejectedValue(new Error('Memory not found'));

      await expect(memoryService.getMemory(memoryId)).rejects.toThrow('Memory not found');
    });

    it('should handle invalid memory ID format', async () => {
      const invalidId = '';

      await expect(memoryService.getMemory(invalidId)).rejects.toThrow(
        'Invalid memory ID'
      );
    });

    it('should handle special characters in memory ID', async () => {
      const specialId = 'mem_!@#$%^&*()';

      mockApiClientInstance.get.mockRejectedValue(new Error('Invalid memory ID format'));

      await expect(memoryService.getMemory(specialId)).rejects.toThrow(
        'Invalid memory ID format'
      );
    });
  });

  describe('getMemories', () => {
    it('should retrieve all memories for a user', async () => {
      const userId = 'user_456';
      const memories = [createValidMemory(), { ...createValidMemory(), id: 'mem_124' }];

      mockApiClientInstance.get.mockResolvedValue(createApiResponse(memories));

      const result = await memoryService.getMemories(userId);

      expect(mockApiClientInstance.get).toHaveBeenCalledWith('/memories', {
        params: { userId },
      });
      expect(result).toEqual(memories);
      expect(result).toHaveLength(2);
    });

    it('should handle empty memory list', async () => {
      const userId = 'user_456';

      mockApiClientInstance.get.mockResolvedValue(createApiResponse([]));

      const result = await memoryService.getMemories(userId);

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('should handle pagination parameters', async () => {
      const userId = 'user_456';
      const options = { page: 2, limit: 10 };
      const memories = [createValidMemory()];

      mockApiClientInstance.get.mockResolvedValue(createApiResponse(memories));

      const result = await memoryService.getMemories(userId, options);

      expect(mockApiClientInstance.get).toHaveBeenCalledWith('/memories', {
        params: { userId, page: 2, limit: 10 },
      });
      expect(result).toEqual(memories);
    });

    it('should handle search filters', async () => {
      const userId = 'user_456';
      const options = { tags: ['important'], importance: 5 };
      const memories = [createValidMemory()];

      mockApiClientInstance.get.mockResolvedValue(createApiResponse(memories));

      const result = await memoryService.getMemories(userId, options);

      expect(mockApiClientInstance.get).toHaveBeenCalledWith('/memories', {
        params: { userId, tags: ['important'], importance: 5 },
      });
    });
  });

  describe('updateMemory', () => {
    it('should update memory successfully', async () => {
      const memoryId = 'mem_123';
      const updateRequest = createValidUpdateRequest();
      const updatedMemory = {
        ...createValidMemory(),
        ...updateRequest,
        updatedAt: '2024-01-02T00:00:00Z',
      };

      mockApiClientInstance.put.mockResolvedValue(createApiResponse(updatedMemory));

      const result = await memoryService.updateMemory(memoryId, updateRequest);

      expect(mockApiClientInstance.put).toHaveBeenCalledWith(
        `/memories/${memoryId}`,
        updateRequest
      );
      expect(result).toEqual(updatedMemory);
      expect(result.updatedAt).not.toBe(createValidMemory().updatedAt);
    });

    it('should handle partial updates', async () => {
      const memoryId = 'mem_123';
      const partialUpdate = { content: 'Only content updated' };
      const updatedMemory = { ...createValidMemory(), content: 'Only content updated' };

      mockApiClientInstance.patch.mockResolvedValue(createApiResponse(updatedMemory));

      const result = await memoryService.updateMemory(memoryId, partialUpdate, {
        partial: true,
      });

      expect(mockApiClientInstance.patch).toHaveBeenCalledWith(
        `/memories/${memoryId}`,
        partialUpdate
      );
      expect(result.content).toBe('Only content updated');
    });

    it('should reject updates to non-existent memory', async () => {
      const memoryId = 'non_existent';
      const updateRequest = createValidUpdateRequest();

      mockApiClientInstance.put.mockRejectedValue(new Error('Memory not found'));

      await expect(
        memoryService.updateMemory(memoryId, updateRequest)
      ).rejects.toThrow('Memory not found');
    });

    it('should handle validation errors in updates', async () => {
      const memoryId = 'mem_123';
      const invalidUpdate = { ...createValidUpdateRequest(), importance: 11 };

      mockApiClientInstance.put.mockRejectedValue(
        new Error('Validation failed: importance must be between 1-10')
      );

      await expect(
        memoryService.updateMemory(memoryId, invalidUpdate)
      ).rejects.toThrow('Validation failed: importance must be between 1-10');
    });

    it('should handle updating tags array', async () => {
      const memoryId = 'mem_123';
      const updateRequest = { tags: ['new-tag', 'another-tag'] };
      const updatedMemory = { ...createValidMemory(), tags: ['new-tag', 'another-tag'] };

      mockApiClientInstance.patch.mockResolvedValue(createApiResponse(updatedMemory));

      const result = await memoryService.updateMemory(memoryId, updateRequest, {
        partial: true,
      });

      expect(result.tags).toEqual(['new-tag', 'another-tag']);
    });

    it('should handle empty tags array', async () => {
      const memoryId = 'mem_123';
      const updateRequest = { tags: [] };
      const updatedMemory = { ...createValidMemory(), tags: [] };

      mockApiClientInstance.patch.mockResolvedValue(createApiResponse(updatedMemory));

      const result = await memoryService.updateMemory(memoryId, updateRequest, {
        partial: true,
      });

      expect(result.tags).toEqual([]);
    });
  });

  describe('deleteMemory', () => {
    it('should delete memory successfully', async () => {
      const memoryId = 'mem_123';

      mockApiClientInstance.delete.mockResolvedValue(
        createApiResponse({ deleted: true })
      );

      const result = await memoryService.deleteMemory(memoryId);

      expect(mockApiClientInstance.delete).toHaveBeenCalledWith(
        `/memories/${memoryId}`
      );
      expect(result).toBe(true);
    });

    it('should handle deletion of non-existent memory', async () => {
      const memoryId = 'non_existent';

      mockApiClientInstance.delete.mockRejectedValue(new Error('Memory not found'));

      await expect(
        memoryService.deleteMemory(memoryId)
      ).rejects.toThrow('Memory not found');
    });

    it('should handle invalid memory ID for deletion', async () => {
      const invalidId = '';

      await expect(
        memoryService.deleteMemory(invalidId)
      ).rejects.toThrow('Invalid memory ID');
    });

    it('should handle server errors during deletion', async () => {
      const memoryId = 'mem_123';

      mockApiClientInstance.delete.mockRejectedValue(
        new Error('Internal server error')
      );

      await expect(
        memoryService.deleteMemory(memoryId)
      ).rejects.toThrow('Internal server error');
    });
  });

  describe('bulkDeleteMemories', () => {
    it('should delete multiple memories successfully', async () => {
      const memoryIds = ['mem_123', 'mem_124', 'mem_125'];

      mockApiClientInstance.delete.mockResolvedValue(
        createApiResponse({ deleted: 3 })
      );

      const result = await memoryService.bulkDeleteMemories(memoryIds);

      expect(mockApiClientInstance.delete).toHaveBeenCalledWith(
        '/memories/bulk',
        { data: { ids: memoryIds } }
      );
      expect(result).toBe(3);
    });

    it('should handle empty array for bulk deletion', async () => {
      const memoryIds: string[] = [];

      await expect(
        memoryService.bulkDeleteMemories(memoryIds)
      ).rejects.toThrow('No memory IDs provided');
    });

    it('should handle partial failures in bulk deletion', async () => {
      const memoryIds = ['mem_123', 'non_existent', 'mem_125'];

      mockApiClientInstance.delete.mockResolvedValue(
        createApiResponse({ deleted: 2, failed: 1 })
      );

      const result = await memoryService.bulkDeleteMemories(memoryIds);

      expect(result).toBe(2);
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts', async () => {
      const createRequest = createValidCreateRequest();

      mockApiClientInstance.post.mockRejectedValue(
        new Error('Request timeout')
      );

      await expect(
        memoryService.createMemory(createRequest)
      ).rejects.toThrow('Request timeout');
    });

    it('should handle rate limiting', async () => {
      const memoryId = 'mem_123';

      mockApiClientInstance.get.mockRejectedValue(
        new Error('Rate limit exceeded')
      );

      await expect(
        memoryService.getMemory(memoryId)
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should handle malformed API responses', async () => {
      const memoryId = 'mem_123';

      mockApiClientInstance.get.mockResolvedValue({ invalid: 'response' } as any);

      await expect(
        memoryService.getMemory(memoryId)
      ).rejects.toThrow('Invalid response format');
    });

    it('should handle unauthorized access', async () => {
      const userId = 'user_456';

      mockApiClientInstance.get.mockRejectedValue(new Error('Unauthorized'));

      await expect(
        memoryService.getMemories(userId)
      ).rejects.toThrow('Unauthorized');
    });

    it('should handle server unavailable', async () => {
      const createRequest = createValidCreateRequest();

      mockApiClientInstance.post.mockRejectedValue(
        new Error('Service unavailable')
      );

      await expect(
        memoryService.createMemory(createRequest)
      ).rejects.toThrow('Service unavailable');
    });
  });

  describe('Edge Cases', () => {
    it('should handle memory with special characters in content', async () => {
      const specialContent = 'Memory with émojis 🧠 and spéciàl chars: <>&"\''; 
      const createRequest = {
        ...createValidCreateRequest(),
        content: specialContent,
      };
      const expectedMemory = { ...createValidMemory(), content: specialContent };

      mockApiClientInstance.post.mockResolvedValue(
        createApiResponse(expectedMemory)
      );

      const result = await memoryService.createMemory(createRequest);

      expect(result.content).toBe(specialContent);
    });

    it('should handle memory with unicode characters', async () => {
      const unicodeContent = '记忆测试 🌟 テスト मेमोरी';
      const createRequest = {
        ...createValidCreateRequest(),
        content: unicodeContent,
      };
      const expectedMemory = { ...createValidMemory(), content: unicodeContent };

      mockApiClientInstance.post.mockResolvedValue(
        createApiResponse(expectedMemory)
      );

      const result = await memoryService.createMemory(createRequest);

      expect(result.content).toBe(unicodeContent);
    });

    it('should handle null and undefined values gracefully', async () => {
      const invalidRequest = {
        ...createValidCreateRequest(),
        context: null,
        tags: undefined,
      };

      mockApiClientInstance.post.mockRejectedValue(
        new Error('Invalid field values')
      );

      await expect(
        memoryService.createMemory(invalidRequest as any)
      ).rejects.toThrow('Invalid field values');
    });

    it('should handle very long tag names', async () => {
      const longTag = 'a'.repeat(100);
      const createRequest = {
        ...createValidCreateRequest(),
        tags: [longTag],
      };

      mockApiClientInstance.post.mockRejectedValue(
        new Error('Tag name too long')
      );

      await expect(
        memoryService.createMemory(createRequest)
      ).rejects.toThrow('Tag name too long');
    });

    it('should handle maximum number of tags', async () => {
      const manyTags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
      const createRequest = {
        ...createValidCreateRequest(),
        tags: manyTags,
      };

      mockApiClientInstance.post.mockRejectedValue(
        new Error('Too many tags')
      );

      await expect(
        memoryService.createMemory(createRequest)
      ).rejects.toThrow('Too many tags');
    });
  });

  describe('Integration Tests', () => {
    it('should create, retrieve, update, and delete memory in sequence', async () => {
      const createRequest = createValidCreateRequest();
      const createdMemory = createValidMemory();
      const updateRequest = createValidUpdateRequest();
      const updatedMemory = { ...createdMemory, ...updateRequest };

      // Create
      mockApiClientInstance.post.mockResolvedValueOnce(
        createApiResponse(createdMemory)
      );
      const created = await memoryService.createMemory(createRequest);

      // Retrieve
      mockApiClientInstance.get.mockResolvedValueOnce(
        createApiResponse(createdMemory)
      );
      const retrieved = await memoryService.getMemory(created.id);

      // Update
      mockApiClientInstance.put.mockResolvedValueOnce(
        createApiResponse(updatedMemory)
      );
      const updated = await memoryService.updateMemory(
        created.id,
        updateRequest
      );

      // Delete
      mockApiClientInstance.delete.mockResolvedValueOnce(
        createApiResponse({ deleted: true })
      );
      const deleted = await memoryService.deleteMemory(created.id);

      expect(created.id).toBe(createdMemory.id);
      expect(retrieved).toEqual(createdMemory);
      expect(updated.content).toBe(updateRequest.content);
      expect(deleted).toBe(true);
    });

    it('should handle concurrent operations gracefully', async () => {
      const createRequests = Array.from(
        { length: 5 },
        () => createValidCreateRequest()
      );
      const expectedMemories = createRequests.map((_, i) => ({
        ...createValidMemory(),
        id: `mem_${i}`,
      }));

      expectedMemories.forEach((memory, i) => {
        mockApiClientInstance.post.mockResolvedValueOnce(
          createApiResponse(memory)
        );
      });

      const promises = createRequests.map((request) =>
        memoryService.createMemory(request)
      );
      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
      results.forEach((result, i) => {
        expect(result.id).toBe(`mem_${i}`);
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle large batch operations efficiently', async () => {
      const userId = 'user_456';
      const largeBatch = Array.from({ length: 1000 }, (_, i) => ({
        ...createValidMemory(),
        id: `mem_${i}`,
      }));

      mockApiClientInstance.get.mockResolvedValue(
        createApiResponse(largeBatch)
      );

      const start = Date.now();
      const result = await memoryService.getMemories(userId);
      const duration = Date.now() - start;

      expect(result).toHaveLength(1000);
      expect(duration).toBeLessThan(5000);
    });

    it('should not leak memory with repeated operations', async () => {
      const createRequest = createValidCreateRequest();
      const expectedMemory = createValidMemory();

      for (let i = 0; i < 100; i++) {
        mockApiClientInstance.post.mockResolvedValueOnce(
          createApiResponse(expectedMemory)
        );
      }

      const promises = Array.from({ length: 100 }, () =>
        memoryService.createMemory(createRequest)
      );
      const results = await Promise.all(promises);

      expect(results).toHaveLength(100);
    });
  });
});