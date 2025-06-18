import { describe, expect, test } from 'bun:test';
import {
  validateCharacter,
  parseAndValidateCharacter,
  isValidCharacter,
} from '../schemas/character';
import type { Character } from '../types/agent';

describe('Character Schema Validation', () => {
  const validCharacter: Character = {
    name: 'Test Character',
    bio: 'A test character for validation',
    messageExamples: [],
    postExamples: [],
    topics: ['AI', 'Testing'],
    adjectives: ['helpful', 'reliable'],
    knowledge: [],
    plugins: [],
    settings: {},
    style: {},
  };

  const minimalValidCharacter: Character = {
    name: 'Minimal Character',
    bio: 'Just the basics',
  };

  describe('validateCharacter', () => {
    test('should validate a complete valid character', () => {
      const result = validateCharacter(validCharacter);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(validCharacter);
      expect(result.error).toBeUndefined();
    });

    test('should validate a minimal valid character', () => {
      const result = validateCharacter(minimalValidCharacter);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(minimalValidCharacter);
    });

    test('should reject character without name', () => {
      const invalidCharacter = { bio: 'No name character' };
      const result = validateCharacter(invalidCharacter);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Character validation failed');
      expect(result.error?.issues).toBeDefined();
    });

    test('should reject character with empty name', () => {
      const invalidCharacter = { name: '', bio: 'Empty name' };
      const result = validateCharacter(invalidCharacter);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Character validation failed');
    });

    test('should reject character without bio', () => {
      const invalidCharacter = { name: 'No Bio Character' };
      const result = validateCharacter(invalidCharacter);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Character validation failed');
    });

    test('should accept bio as string array', () => {
      const characterWithArrayBio = {
        name: 'Array Bio Character',
        bio: ['First line', 'Second line', 'Third line'],
      };
      const result = validateCharacter(characterWithArrayBio);
      expect(result.success).toBe(true);
    });

    test('should reject unknown properties in strict mode', () => {
      const characterWithExtra = {
        ...validCharacter,
        unknownProperty: 'should be rejected',
        anotherUnknown: 123,
      };
      const result = validateCharacter(characterWithExtra);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Unrecognized key');
    });

    test('should validate optional fields correctly', () => {
      const characterWithOptionals = {
        name: 'Optional Fields Character',
        bio: 'Testing optional fields',
        username: 'test_user',
        system: 'Test system prompt',
        messageExamples: [
          [
            {
              name: 'user',
              content: { text: 'Hello' },
            },
            {
              name: 'assistant',
              content: { text: 'Hi there!' },
            },
          ],
        ],
        postExamples: ['Example post 1', 'Example post 2'],
        topics: ['AI', 'Testing', 'Validation'],
        adjectives: ['helpful', 'reliable', 'intelligent'],
        knowledge: [
          'knowledge/file1.txt',
          { path: 'knowledge/file2.txt', shared: true },
          { directory: 'knowledge/shared', shared: true },
        ],
        plugins: ['plugin1', 'plugin2'],
        settings: {
          temperature: 0.7,
          maxTokens: 1000,
          debug: true,
        },
        secrets: {
          apiKey: 'secret-key',
          enabled: true,
        },
        style: {
          all: ['casual', 'friendly'],
          chat: ['responsive', 'helpful'],
          post: ['engaging', 'informative'],
        },
      };
      const result = validateCharacter(characterWithOptionals);
      expect(result.success).toBe(true);
    });

    test('should validate UUID format for id field', () => {
      const characterWithValidUuid = {
        ...validCharacter,
        id: '123e4567-e89b-12d3-a456-426614174000',
      };
      const result = validateCharacter(characterWithValidUuid);
      expect(result.success).toBe(true);
    });

    test('should reject invalid UUID format for id field', () => {
      const characterWithInvalidUuid = {
        ...validCharacter,
        id: 'invalid-uuid-format',
      };
      const result = validateCharacter(characterWithInvalidUuid);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid UUID format');
    });
  });

  describe('parseAndValidateCharacter', () => {
    test('should parse and validate valid JSON character', () => {
      const jsonString = JSON.stringify(validCharacter);
      const result = parseAndValidateCharacter(jsonString);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(validCharacter);
    });

    test('should handle malformed JSON', () => {
      const malformedJson = '{ "name": "Test", "bio": "Test" '; // Missing closing brace
      const result = parseAndValidateCharacter(malformedJson);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid JSON');
    });

    test('should handle JSON with invalid character data', () => {
      const invalidCharacterJson = JSON.stringify({ name: '', bio: 'Invalid' });
      const result = parseAndValidateCharacter(invalidCharacterJson);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Character validation failed');
    });

    test('should handle empty JSON object', () => {
      const emptyJson = '{}';
      const result = parseAndValidateCharacter(emptyJson);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Character validation failed');
    });
  });

  describe('isValidCharacter', () => {
    test('should return true for valid character', () => {
      expect(isValidCharacter(validCharacter)).toBe(true);
    });

    test('should return false for invalid character', () => {
      const invalidCharacter = { name: '', bio: 'Invalid' };
      expect(isValidCharacter(invalidCharacter)).toBe(false);
    });

    test('should return false for non-object input', () => {
      expect(isValidCharacter('string')).toBe(false);
      expect(isValidCharacter(null)).toBe(false);
      expect(isValidCharacter(undefined)).toBe(false);
      expect(isValidCharacter(123)).toBe(false);
    });
  });

  describe('Complex validation scenarios', () => {
    test('should validate character with complex knowledge array', () => {
      const characterWithComplexKnowledge = {
        name: 'Knowledge Character',
        bio: 'Testing knowledge validation',
        knowledge: [
          'simple/path.txt',
          { path: 'path/with/config.txt', shared: false },
          { path: 'shared/path.txt', shared: true },
          { directory: 'knowledge/dir' },
          { directory: 'shared/dir', shared: true },
        ],
      };
      const result = validateCharacter(characterWithComplexKnowledge);
      expect(result.success).toBe(true);
    });

    test('should validate character with complex message examples', () => {
      const characterWithComplexMessages = {
        name: 'Message Character',
        bio: 'Testing message validation',
        messageExamples: [
          [
            {
              name: 'user',
              content: {
                text: 'Hello, how are you?',
                source: 'user',
              },
            },
            {
              name: 'assistant',
              content: {
                text: 'I am doing well, thank you!',
                source: 'assistant',
                attachments: [{ type: 'text', data: 'additional info' }],
              },
            },
          ],
          [
            {
              name: 'user',
              content: { text: 'What is the weather like?' },
            },
            {
              name: 'assistant',
              content: {
                text: 'I would need to check a weather service for current conditions.',
                url: 'https://weather.example.com',
              },
            },
          ],
        ],
      };
      const result = validateCharacter(characterWithComplexMessages);
      expect(result.success).toBe(true);
    });

    test('should validate character with flexible settings', () => {
      const characterWithFlexibleSettings = {
        name: 'Settings Character',
        bio: 'Testing settings validation',
        settings: {
          temperature: 0.8,
          maxTokens: 2000,
          enableDebug: true,
          model: 'gpt-4',
          customConfig: {
            nested: {
              deeply: {
                value: 'test',
              },
            },
          },
          arrayValue: [1, 2, 3],
        },
        secrets: {
          apiKey: 'sk-test123',
          secretNumber: 42,
          isEnabled: true,
        },
      };
      const result = validateCharacter(characterWithFlexibleSettings);
      expect(result.success).toBe(true);
    });
  });

  describe('Edge cases and error handling', () => {
    test('should handle null and undefined inputs', () => {
      expect(validateCharacter(null).success).toBe(false);
      expect(validateCharacter(undefined).success).toBe(false);
    });

    test('should handle non-object inputs', () => {
      expect(validateCharacter('string').success).toBe(false);
      expect(validateCharacter(123).success).toBe(false);
      expect(validateCharacter([]).success).toBe(false);
    });

    test('should provide detailed error information', () => {
      const invalidCharacter = {
        name: '', // Invalid: empty string
        bio: 123, // Invalid: should be string or string[]
        messageExamples: 'invalid', // Invalid: should be array
      };
      const result = validateCharacter(invalidCharacter);
      expect(result.success).toBe(false);
      expect(result.error?.issues).toBeDefined();
      expect(result.error?.issues?.length).toBeGreaterThan(0);
    });
  });
});
