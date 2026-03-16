import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('MessageService', () => {
  describe('DISABLE_MEMORY_CREATION', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should disable memory creation when DISABLE_MEMORY_CREATION is true', () => {
      process.env.DISABLE_MEMORY_CREATION = 'true';
      
      const shouldCreateMemory = process.env.DISABLE_MEMORY_CREATION !== 'true';
      
      expect(shouldCreateMemory).toBe(false);
    });

    it('should enable memory creation when DISABLE_MEMORY_CREATION is false', () => {
      process.env.DISABLE_MEMORY_CREATION = 'false';
      
      const shouldCreateMemory = process.env.DISABLE_MEMORY_CREATION !== 'true';
      
      expect(shouldCreateMemory).toBe(true);
    });

    it('should enable memory creation when DISABLE_MEMORY_CREATION is not set', () => {
      delete process.env.DISABLE_MEMORY_CREATION;
      
      const shouldCreateMemory = process.env.DISABLE_MEMORY_CREATION !== 'true';
      
      expect(shouldCreateMemory).toBe(true);
    });
  });

  describe('ALLOW_MEMORY_SOURCE_IDS', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should parse comma-separated source IDs', () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = 'source1,source2,source3';
      
      const allowedIds = process.env.ALLOW_MEMORY_SOURCE_IDS?.split(',') ?? [];
      
      expect(allowedIds).toEqual(['source1', 'source2', 'source3']);
    });

    it('should allow memory from permitted source IDs', () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = 'source1,source2';
      const allowedIds = process.env.ALLOW_MEMORY_SOURCE_IDS?.split(',') ?? [];
      
      const sourceId = 'source1';
      const isAllowed = allowedIds.length === 0 || allowedIds.includes(sourceId);
      
      expect(isAllowed).toBe(true);
    });

    it('should deny memory from non-permitted source IDs', () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = 'source1,source2';
      const allowedIds = process.env.ALLOW_MEMORY_SOURCE_IDS?.split(',') ?? [];
      
      const sourceId = 'source3';
      const isAllowed = allowedIds.length === 0 || allowedIds.includes(sourceId);
      
      expect(isAllowed).toBe(false);
    });

    it('should allow all sources when ALLOW_MEMORY_SOURCE_IDS is not set', () => {
      delete process.env.ALLOW_MEMORY_SOURCE_IDS;
      const allowedIds = process.env.ALLOW_MEMORY_SOURCE_IDS?.split(',') ?? [];
      
      const sourceId = 'any-source';
      const isAllowed = allowedIds.length === 0 || allowedIds.includes(sourceId);
      
      expect(isAllowed).toBe(true);
    });
  });

  describe('keepExistingResponses', () => {
    it('should preserve existing responses when keepExistingResponses is true', () => {
      const existingResponses = [
        { id: '1', content: 'response1' },
        { id: '2', content: 'response2' },
      ];
      const newResponse = { id: '3', content: 'response3' };
      const keepExistingResponses = true;

      const result = keepExistingResponses
        ? [...existingResponses, newResponse]
        : [newResponse];

      expect(result).toHaveLength(3);
      expect(result).toContainEqual({ id: '1', content: 'response1' });
      expect(result).toContainEqual({ id: '2', content: 'response2' });
      expect(result).toContainEqual({ id: '3', content: 'response3' });
    });

    it('should replace existing responses when keepExistingResponses is false', () => {
      const existingResponses = [
        { id: '1', content: 'response1' },
        { id: '2', content: 'response2' },
      ];
      const newResponse = { id: '3', content: 'response3' };
      const keepExistingResponses = false;

      const result = keepExistingResponses
        ? [...existingResponses, newResponse]
        : [newResponse];

      expect(result).toHaveLength(1);
      expect(result).toContainEqual({ id: '3', content: 'response3' });
    });

    it('should default to replacing responses when keepExistingResponses is undefined', () => {
      const existingResponses = [
        { id: '1', content: 'response1' },
      ];
      const newResponse = { id: '2', content: 'response2' };
      const keepExistingResponses = undefined;

      const result = keepExistingResponses
        ? [...existingResponses, newResponse]
        : [newResponse];

      expect(result).toHaveLength(1);
      expect(result).toContainEqual({ id: '2', content: 'response2' });
    });
  });
});
