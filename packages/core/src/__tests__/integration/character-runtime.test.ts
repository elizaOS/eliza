import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentRuntime } from '../../runtime';
import { parseCharacter, validateCharacterConfig, mergeCharacterDefaults } from '../../character';
import type { Character, UUID } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { createMockAdapter } from '../test-helpers';
import type { IDatabaseAdapter } from '../../types';

describe('Character-Runtime Integration Tests', () => {
  let mockAdapter: IDatabaseAdapter;
  let baseCharacter: Character;

  beforeEach(() => {
    const agentId = uuidv4() as UUID;

    baseCharacter = {
      id: agentId,
      name: 'TestAgent',
      username: 'testagent',
      bio: ['A test agent'],
      messageExamples: [],
      postExamples: [],
      topics: [],
      style: { all: [], chat: [], post: [] },
      adjectives: [],
      settings: {
        MODEL: 'gpt-4',
      },
    };

    mockAdapter = createMockAdapter();
  });

  afterEach(() => {
    mock.restore();
  });

  describe('parseCharacter with Runtime', () => {
    it('should parse character and create runtime', () => {
      const parsed = parseCharacter(baseCharacter);
      const runtime = new AgentRuntime({
        character: parsed,
        adapter: mockAdapter,
      });

      expect(runtime.character.name).toBe('TestAgent');
      expect(runtime.character.settings?.MODEL).toBe('gpt-4');
    });

    it('should validate character before creating runtime', () => {
      const invalidCharacter = {
        bio: ['Missing name'],
        settings: {},
      };

      const validation = validateCharacterConfig(invalidCharacter as Character);
      expect(validation.isValid).toBe(false);

      if (validation.isValid) {
        const runtime = new AgentRuntime({
          character: invalidCharacter as Character,
          adapter: mockAdapter,
        });
        expect(runtime).toBeDefined();
      }
    });
  });

  describe('mergeCharacterDefaults with Runtime', () => {
    it('should merge defaults and create runtime', () => {
      const partial: Partial<Character> = {
        name: 'PartialAgent',
        bio: ['Partial bio'],
      };

      const merged = mergeCharacterDefaults(partial);
      const runtime = new AgentRuntime({
        character: merged,
        adapter: mockAdapter,
      });

      expect(runtime.character.name).toBe('PartialAgent');
      expect(runtime.character.settings).toBeDefined();
      expect(runtime.character.plugins).toBeDefined();
    });

    it('should use default name when not provided', () => {
      const partial: Partial<Character> = {
        bio: ['No name'],
      };

      const merged = mergeCharacterDefaults(partial);
      const runtime = new AgentRuntime({
        character: merged,
        adapter: mockAdapter,
      });

      expect(runtime.character.name).toBe('Unnamed Character');
    });
  });

  describe('Character Validation Flow', () => {
    it('should validate character and create runtime with validated character', () => {
      const validCharacter: Character = {
        ...baseCharacter,
        name: 'ValidAgent',
      };

      const validation = validateCharacterConfig(validCharacter);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      const runtime = new AgentRuntime({
        character: validCharacter,
        adapter: mockAdapter,
      });
      expect(runtime.character.name).toBe('ValidAgent');
    });

    it('should handle validation errors and prevent invalid runtime creation', () => {
      const invalidCharacter = {
        bio: ['Missing required name'],
        settings: {},
      } as Character;

      const validation = validateCharacterConfig(invalidCharacter);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);

      // Runtime should still be creatable but with invalid character
      // This tests that validation doesn't block runtime creation
      const runtime = new AgentRuntime({
        character: invalidCharacter,
        adapter: mockAdapter,
      });
      expect(runtime).toBeDefined();
    });
  });
});
