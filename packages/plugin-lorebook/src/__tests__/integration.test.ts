import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { characterLorePlugin } from '../index';
import { LoreService } from '../services/lore-service';
import { loreProvider } from '../providers/lore-provider';
import type { IAgentRuntime, UUID, LoreEntry } from '@elizaos/core';

describe('Character Lore Plugin Integration', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      character: {
        name: 'Dr. Thorne',
        bio: 'Relationship economist',
        lore: [
          {
            loreKey: 'concept_fitness_test',
            vectorText: 'testing, boundaries, provoking, drama',
            content:
              "[CONCEPT: Fitness Test]\nWomen constantly ping the man's sonar to check for solidity.",
            metadata: { category: 'concept' },
          },
          {
            loreKey: 'tactic_amused_mastery',
            vectorText: 'yelling, argument, anger, emotional, reaction',
            content:
              "[TACTIC: Amused Mastery]\nThe only correct response to a partner's emotional volatility.",
            metadata: { category: 'tactic' },
          },
          {
            loreKey: 'concept_smv',
            vectorText: 'attractive, value, market, rating',
            content: '[CONCEPT: SMV]\nSexual Marketplace Value.',
            metadata: { category: 'concept' },
          },
        ],
      },
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
        success: mock(() => {}),
      },
    } as unknown as IAgentRuntime;
  });

  describe('plugin structure', () => {
    it('should make service and provider available', () => {
      expect(characterLorePlugin.services).toBeDefined();
      expect(characterLorePlugin.services?.[0]).toBe(LoreService);

      expect(characterLorePlugin.providers).toBeDefined();
      expect(characterLorePlugin.providers?.[0]).toBe(loreProvider);
    });

    it('should have schema defined', () => {
      expect(characterLorePlugin.schema).toBeDefined();
      expect(characterLorePlugin.schema?.characterLore).toBeDefined();
      expect(characterLorePlugin.schema?.characterLoreEmbeddings).toBeDefined();
    });
  });

  describe('lore validation', () => {
    it('should handle invalid lore configuration', async () => {
      mockRuntime.character.lore = 'invalid' as any;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow(
        'Invalid character lore configuration'
      );
    });

    it('should reject entry with wrong type for loreKey', async () => {
      const invalidLore = [
        {
          loreKey: 123,
          vectorText: 'test',
          content: 'content',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow();
    });

    it('should reject entry with wrong type for vectorText', async () => {
      const invalidLore = [
        {
          loreKey: 'test',
          vectorText: ['array', 'not', 'string'],
          content: 'content',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow();
    });

    it('should reject entry with wrong type for content', async () => {
      const invalidLore = [
        {
          loreKey: 'test',
          vectorText: 'test',
          content: { object: 'not string' },
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow();
    });

    it('should validate multiple entries and report first error', async () => {
      const invalidLore = [
        {
          loreKey: 'valid_1',
          vectorText: 'test',
          content: 'valid content',
        },
        {
          loreKey: 'valid_2',
          vectorText: 'test',
          content: 'valid content',
        },
        {
          loreKey: 'invalid_3',
          vectorText: null,
          content: 'content',
        },
      ] as any;

      mockRuntime.character.lore = invalidLore;

      await expect(characterLorePlugin.init?.({}, mockRuntime)).rejects.toThrow('index 2');
    });
  });
});
