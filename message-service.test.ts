import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Note: These tests require the actual message-service module to export testable functions.
// If tests fail with "function is not defined", the service module needs to export the relevant functions.

// Create mock functions that we can inspect
const mockCreateMemory = vi.fn();
const mockDeleteResponse = vi.fn().mockResolvedValue({ deleted: true });
const mockListResponses = vi.fn().mockResolvedValue({ data: [{ id: 'resp_existing' }] });
const mockResponsesCreate = vi.fn().mockResolvedValue({
  id: 'resp_123',
  output: [{ type: 'message', content: [{ type: 'text', text: 'Test response' }] }]
});

// Mock the runtime/database layer to capture memory creation calls
vi.mock('./src/runtime', () => ({
  createMemory: (...args: unknown[]) => mockCreateMemory(...args),
}));

// Mock the OpenAI client
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      responses: {
        create: (...args: unknown[]) => mockResponsesCreate(...args),
        list: (...args: unknown[]) => mockListResponses(...args),
        del: (...args: unknown[]) => mockDeleteResponse(...args)
      }
    }))
  };
});

describe('message-service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('DISABLE_MEMORY_CREATION environment variable', () => {
    it('should respect DISABLE_MEMORY_CREATION=true and not create memories', async () => {
      process.env.DISABLE_MEMORY_CREATION = 'true';
      
      // Re-import to pick up new env value
      const service = await import('./src/services/message-service');
      
      // Verify the service exports the expected function
      expect(service.processMessage).toBeDefined();
      expect(typeof service.processMessage).toBe('function');
      
      // Call the actual service function and verify mockCreateMemory was NOT called
      await service.processMessage({ content: 'test', roomId: 'room1' });
      expect(mockCreateMemory).not.toHaveBeenCalled();
    });

    it('should create memories when DISABLE_MEMORY_CREATION is not set', async () => {
      delete process.env.DISABLE_MEMORY_CREATION;
      
      const service = await import('./src/services/message-service');
      
      // Verify the service exports the expected function
      expect(service.processMessage).toBeDefined();
      expect(typeof service.processMessage).toBe('function');
      
      // Call the actual service function and verify mockCreateMemory WAS called
      await service.processMessage({ content: 'test', roomId: 'room1' });
      expect(mockCreateMemory).toHaveBeenCalled();
    });
  });

  describe('ALLOW_MEMORY_SOURCE_IDS environment variable', () => {
    it('should only allow memories from specified source IDs', async () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = 'source1,source2,source3';
      
      const service = await import('./src/services/message-service');
      
      // Verify the service exports the expected function
      expect(service.processMessage).toBeDefined();
      expect(typeof service.processMessage).toBe('function');
      
      // Test that messages from allowed sources are processed
      await service.processMessage({ content: 'test', roomId: 'room1', sourceId: 'source1' });
      expect(mockCreateMemory).toHaveBeenCalled();
      
      mockCreateMemory.mockClear();
      
      // Test that messages from non-allowed sources are rejected
      await service.processMessage({ content: 'test', roomId: 'room1', sourceId: 'source_not_allowed' });
      expect(mockCreateMemory).not.toHaveBeenCalled();
    });

    it('should allow all sources when ALLOW_MEMORY_SOURCE_IDS is empty', async () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = '';
      
      const service = await import('./src/services/message-service');
      
      // Verify the service exports the expected function
      expect(service.processMessage).toBeDefined();
      expect(typeof service.processMessage).toBe('function');
      
      // Empty string should allow all sources (no filtering)
      await service.processMessage({ content: 'test', roomId: 'room1', sourceId: 'any_source' });
      expect(mockCreateMemory).toHaveBeenCalled();
    });
  });

  describe('keepExistingResponses behavior', () => {
    it('should preserve existing responses when keepExistingResponses is true', async () => {
      const service = await import('./src/services/message-service');
      
      // Verify the service exports the expected function
      expect(service.sendMessage).toBeDefined();
      expect(typeof service.sendMessage).toBe('function');
      
      // Test with keepExistingResponses: true - should NOT delete existing responses
      await service.sendMessage({ content: 'test' }, { keepExistingResponses: true });
      expect(mockDeleteResponse).not.toHaveBeenCalled();
    });

    it('should clear existing responses when keepExistingResponses is false', async () => {
      const service = await import('./src/services/message-service');
      
      // Verify the service exports the expected function
      expect(service.sendMessage).toBeDefined();
      expect(typeof service.sendMessage).toBe('function');
      
      // Test with keepExistingResponses: false - SHOULD delete existing responses
      await service.sendMessage({ content: 'test' }, { keepExistingResponses: false });
      // First it lists existing responses, then deletes them
      expect(mockListResponses).toHaveBeenCalled();
      expect(mockDeleteResponse).toHaveBeenCalled();
    });
  });
});
