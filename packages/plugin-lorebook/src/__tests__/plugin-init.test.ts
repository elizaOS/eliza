import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { characterLorePlugin } from '../index';
import type { IAgentRuntime, UUID, LoreEntry } from '@elizaos/core';

describe('Character Lore Plugin', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      character: {
        name: 'TestAgent',
        bio: 'Test bio',
      },
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    } as unknown as IAgentRuntime;
  });

  describe('plugin metadata', () => {
    it('should have correct name', () => {
      expect(characterLorePlugin.name).toBe('@elizaos/plugin-character-lore');
    });

    it('should have description', () => {
      expect(characterLorePlugin.description).toContain('lore management');
    });

    it('should export schema', () => {
      expect(characterLorePlugin.schema).toBeDefined();
      expect(characterLorePlugin.schema?.characterLore).toBeDefined();
      expect(characterLorePlugin.schema?.characterLoreEmbeddings).toBeDefined();
    });

    it('should export services', () => {
      expect(characterLorePlugin.services).toBeDefined();
      expect(characterLorePlugin.services?.length).toBe(1);
    });

    it('should export providers', () => {
      expect(characterLorePlugin.providers).toBeDefined();
      expect(characterLorePlugin.providers?.length).toBe(1);
    });
  });

  describe('plugin initialization', () => {
    it('should initialize without lore', async () => {
      await characterLorePlugin.init?.({}, mockRuntime);

      expect(mockRuntime.logger.info).toHaveBeenCalledWith(
        'No character lore configured (character.lore is not set)'
      );
    });

    it('should validate lore entries', async () => {
      const validLore: LoreEntry[] = [
        {
          loreKey: 'test_concept',
          vectorText: 'test, concept, example',
          content: '[TEST: Concept]\nTest content',
          metadata: { category: 'test' },
        },
      ];

      mockRuntime.character.lore = validLore;

      await characterLorePlugin.init?.({}, mockRuntime);

      expect(mockRuntime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Character lore validation passed: 1 entries')
      );
    });

    it('should reject lore with missing loreKey', async () => {
      const invalidLore = [
        {
          vectorText: 'test',
          content: 'content',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow(
        "missing 'loreKey'"
      );
    });

    it('should reject lore with missing vectorText', async () => {
      const invalidLore = [
        {
          loreKey: 'test',
          content: 'content',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow(
        "missing 'vectorText'"
      );
    });

    it('should reject lore with missing content', async () => {
      const invalidLore = [
        {
          loreKey: 'test',
          vectorText: 'test',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow(
        "missing 'content'"
      );
    });

    it('should reject non-array lore', async () => {
      mockRuntime.character.lore = { invalid: 'format' } as any;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow('must be an array');
    });

    it('should reject lore with invalid metadata type', async () => {
      const invalidLore = [
        {
          loreKey: 'test',
          vectorText: 'test',
          content: 'content',
          metadata: 'invalid',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow(
        "invalid 'metadata'"
      );
    });

    it('should accept valid lore with metadata', async () => {
      const validLore: LoreEntry[] = [
        {
          loreKey: 'test_1',
          vectorText: 'test',
          content: 'content',
          metadata: { category: 'test', tags: ['important'] },
        },
        {
          loreKey: 'test_2',
          vectorText: 'test',
          content: 'content',
        },
      ];

      mockRuntime.character.lore = validLore;

      await characterLorePlugin.init?.({}, mockRuntime);

      expect(mockRuntime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('validation passed: 2 entries')
      );
    });

    it('should provide detailed error messages with index', async () => {
      const invalidLore = [
        {
          loreKey: 'valid_1',
          vectorText: 'test',
          content: 'content',
        },
        {
          loreKey: 'valid_2',
          vectorText: 'test',
          content: 'content',
        },
        {
          loreKey: 'invalid_3',
          content: 'content',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow('index 2');
    });
  });

  describe('lore entry validation edge cases', () => {
    it('should reject null lore entry', async () => {
      mockRuntime.character.lore = [null] as any;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow('not an object');
    });

    it('should reject undefined lore entry', async () => {
      mockRuntime.character.lore = [undefined] as any;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow('not an object');
    });

    it('should accept lore with complex metadata', async () => {
      const validLore: LoreEntry[] = [
        {
          loreKey: 'complex_test',
          vectorText: 'complex, metadata, test',
          content: '[COMPLEX: Test]\nContent',
          metadata: {
            category: 'test',
            tags: ['tag1', 'tag2'],
            nested: {
              field: 'value',
              array: [1, 2, 3],
            },
            count: 42,
            enabled: true,
          },
        },
      ];

      mockRuntime.character.lore = validLore;

      await characterLorePlugin.init?.({}, mockRuntime);

      expect(mockRuntime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('validation passed')
      );
    });
  });
});
