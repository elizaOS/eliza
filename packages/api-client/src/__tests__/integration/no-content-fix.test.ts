import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentsService } from '../../services/agents';
import { MemoryService } from '../../services/memory';
import { ApiClientConfig } from '../../types/base';

describe('No Content Response Fix Integration', () => {
  let agentsService: AgentsService;
  let memoryService: MemoryService;
  let fetchMock: any;

  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
    timeout: 5000,
  };

  beforeEach(() => {
    agentsService = new AgentsService(mockConfig);
    memoryService = new MemoryService(mockConfig);
    fetchMock = global.fetch;
  });

  afterEach(() => {
    global.fetch = fetchMock;
  });

  it('should handle deleteAgent with 204 response without runtime errors', async () => {
    // Mock a 204 No Content response
    global.fetch = async (url: string, options: any) => {
      expect(url).toContain('/api/agents/test-agent-id');
      expect(options.method).toBe('DELETE');

      return {
        ok: true,
        status: 204,
        headers: {
          get: (name: string) => null,
        },
        json: async () => {
          throw new Error('No content to parse');
        },
      } as Response;
    };

    const result = await agentsService.deleteAgent('test-agent-id' as any);

    // Verify the result has the expected structure
    expect(result).toEqual({ success: true });
    expect(result.success).toBe(true);

    // This should not throw runtime errors when accessing properties
    expect(() => {
      const success = result.success;
      expect(typeof success).toBe('boolean');
    }).not.toThrow();
  });

  it('should handle deleteAgentLog with 204 response safely', async () => {
    global.fetch = async (url: string, options: any) => {
      expect(url).toContain('/api/agents/test-agent-id/logs/test-log-id');
      expect(options.method).toBe('DELETE');

      return {
        ok: true,
        status: 204,
        headers: {
          get: () => null,
        },
        json: async () => {
          throw new Error('No content');
        },
      } as Response;
    };

    const result = await agentsService.deleteAgentLog('test-agent-id' as any, 'test-log-id' as any);

    expect(result).toEqual({ success: true });
    expect(result.success).toBe(true);
  });

  it('should handle clearAgentMemories with 204 response safely', async () => {
    global.fetch = async (url: string, options: any) => {
      expect(url).toContain('/api/memory/test-agent-id/memories');
      expect(options.method).toBe('DELETE');

      return {
        ok: true,
        status: 204,
        headers: {
          get: () => null,
        },
        json: async () => {
          throw new Error('No content');
        },
      } as Response;
    };

    const result = await memoryService.clearAgentMemories('test-agent-id' as any);

    // The service expects a specific return type
    expect(result).toEqual({ success: true });
    expect(result.success).toBe(true);
  });

  it('should handle multiple 204 operations without type assertion errors', async () => {
    let callCount = 0;

    global.fetch = async (url: string, options: any) => {
      callCount++;

      return {
        ok: true,
        status: 204,
        headers: {
          get: () => null,
        },
        json: async () => {
          throw new Error('No content');
        },
      } as Response;
    };

    // Test multiple operations that return 204
    const deleteResult = await agentsService.deleteAgent('agent-1' as any);
    const logDeleteResult = await agentsService.deleteAgentLog('agent-1' as any, 'log-1' as any);
    const memoryResult = await memoryService.clearAgentMemories('agent-1' as any);

    expect(callCount).toBe(3);

    // All should return proper success objects
    expect(deleteResult).toEqual({ success: true });
    expect(logDeleteResult).toEqual({ success: true });
    expect(memoryResult).toEqual({ success: true });

    // Verify properties are accessible without runtime errors
    expect(deleteResult.success).toBe(true);
    expect(logDeleteResult.success).toBe(true);
    expect(memoryResult.success).toBe(true);
  });

  it('should handle empty content-length responses safely', async () => {
    global.fetch = async (url: string, options: any) => {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '0' : null),
        },
        json: async () => {
          throw new Error('No content');
        },
      } as Response;
    };

    const result = await agentsService.deleteAgent('test-agent-id' as any);

    expect(result).toEqual({ success: true });
    expect(result.success).toBe(true);
  });

  it('should handle JSON parse failures for successful responses', async () => {
    global.fetch = async (url: string, options: any) => {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '50' : null),
        },
        json: async () => {
          throw new Error('Malformed JSON');
        },
      } as Response;
    };

    const result = await agentsService.deleteAgent('test-agent-id' as any);

    expect(result).toEqual({ success: true });
    expect(result.success).toBe(true);
  });

  it('should demonstrate the fix prevents runtime property access errors', async () => {
    global.fetch = async () =>
      ({
        ok: true,
        status: 204,
        headers: {
          get: () => null,
        },
        json: async () => {
          throw new Error('No content');
        },
      }) as Response;

    const result = await agentsService.deleteAgent('test-agent-id' as any);

    // Before the fix, this would fail because result would be an empty object {}
    // but the type system would think it has a 'success' property
    // After the fix, this should work correctly
    expect(result.success).toBe(true);
    expect(result.success).not.toBeUndefined();
    expect(result.success).not.toBeNull();

    // Test that we can safely destructure
    const { success } = result;
    expect(success).toBe(true);

    // Test that conditional logic works correctly
    if (result.success) {
      expect(true).toBe(true); // This should execute
    } else {
      expect(true).toBe(false); // This should not execute
    }
  });
});
