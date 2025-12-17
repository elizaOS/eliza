import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { loreProvider } from '../providers/lore-provider';
import { LoreService } from '../services/lore-service';
import type { IAgentRuntime, Memory, UUID, State } from '@elizaos/core';
import type { StoredLoreEntry } from '../types';

describe('loreProvider', () => {
  let mockRuntime: IAgentRuntime;
  let mockLoreService: LoreService;
  let mockState: State;
  let mockMessage: Memory;

  beforeEach(() => {
    mockLoreService = new LoreService();

    mockRuntime = {
      agentId: 'test-agent' as UUID,
      character: { name: 'TestAgent', bio: 'Test' },
      getService: mock((name: string) => {
        if (name === 'lore') return mockLoreService;
        return null;
      }),
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    } as unknown as IAgentRuntime;

    mockState = {
      values: {},
      data: {},
      text: '',
    } as State;

    mockMessage = {
      id: 'msg-1' as UUID,
      entityId: 'user-1' as UUID,
      roomId: 'room-1' as UUID,
      content: { text: 'Why does she keep testing me?' },
      createdAt: Date.now(),
    } as Memory;
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(loreProvider.name).toBe('characterLore');
    });

    it('should have description', () => {
      expect(loreProvider.description).toBeDefined();
      expect(typeof loreProvider.description).toBe('string');
    });
  });

  describe('lore retrieval', () => {
    it('should return null when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(result).toBeNull();
    });

    it('should return null when message has no text', async () => {
      mockMessage.content.text = '';

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(result).toBeNull();
    });

    it('should return empty when no relevant lore is found', async () => {
      mockLoreService.searchLore = mock(async () => []);

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(result?.text).toBe('');
      expect(result?.values?.hasLore).toBe(false);
    });

    it('should return formatted lore when relevant entries are found', async () => {
      const mockLoreEntries: StoredLoreEntry[] = [
        {
          id: 'lore-1' as UUID,
          agentId: mockRuntime.agentId,
          loreKey: 'concept_fitness_test',
          vectorText: 'testing, boundaries, provoking',
          content:
            "[CONCEPT: Fitness Test]\nWomen constantly ping the man's sonar to check for solidity.",
          metadata: { category: 'concept' },
          similarity: 0.89,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockLoreService.searchLore = mock(async () => mockLoreEntries);

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(result?.text).toContain('CRITICAL PSYCHOLOGICAL FRAMEWORK');
      expect(result?.text).toContain('***');
      expect(result?.text).toContain('[CONCEPT: Fitness Test]');
      expect(result?.values?.hasLore).toBe(true);
      expect(result?.values?.loreCount).toBe(1);
    });

    it('should pass correct options to service', async () => {
      const searchMock = mock(async () => []);
      mockLoreService.searchLore = searchMock;

      await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(searchMock).toHaveBeenCalledWith('Why does she keep testing me?', {
        topK: 3,
        similarityThreshold: 0.75,
        includeMetadata: false,
      });
    });

    it('should handle errors and return null', async () => {
      mockLoreService.searchLore = mock(async () => {
        throw new Error('Search failed');
      });

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(result).toBeNull();
    });
  });

  describe('formatting', () => {
    it('should use dinkus (***) separators', async () => {
      const mockLoreEntries: StoredLoreEntry[] = [
        {
          id: 'lore-1' as UUID,
          agentId: mockRuntime.agentId,
          loreKey: 'test',
          vectorText: 'test',
          content: '[TEST]\nContent 1',
          metadata: {},
          similarity: 0.85,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'lore-2' as UUID,
          agentId: mockRuntime.agentId,
          loreKey: 'test2',
          vectorText: 'test',
          content: '[TEST2]\nContent 2',
          metadata: {},
          similarity: 0.8,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockLoreService.searchLore = mock(async () => mockLoreEntries);

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      const dinkusCount = (result?.text?.match(/\*\*\*/g) || []).length;
      expect(dinkusCount).toBeGreaterThanOrEqual(2);
    });

    it('should include framework header', async () => {
      const mockLoreEntries: StoredLoreEntry[] = [
        {
          id: 'lore-1' as UUID,
          agentId: mockRuntime.agentId,
          loreKey: 'test',
          vectorText: 'test',
          content: '[TEST]\nContent',
          metadata: {},
          similarity: 0.85,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockLoreService.searchLore = mock(async () => mockLoreEntries);

      const result = await loreProvider.get(mockRuntime, mockMessage, mockState);

      expect(result?.text).toContain('CRITICAL PSYCHOLOGICAL FRAMEWORK');
      expect(result?.text).toContain('axiomatic truths');
    });
  });
});
