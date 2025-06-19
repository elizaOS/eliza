import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import {
  tryLoadFile,
  loadCharacter,
  jsonToCharacter,
  loadCharactersFromUrl,
} from '../../../src/commands/start/utils/loader';
import type { Character } from '@elizaos/core';

const TEST_MULTI_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/multi-chars.json';

// Mock dependencies
mock.module('node:fs', () => ({
  existsSync: mock(() => true),
  readFileSync: mock(() => '{}'),
  statSync: mock(() => ({ isDirectory: () => true })),
  writeFileSync: mock(),
  promises: {
    readFile: mock(() => '{}'),
    writeFile: mock(),
    mkdir: mock(),
  },
}));
mock.module('@elizaos/core', () => ({
  logger: {
    error: mock(),
    warn: mock(),
    info: mock(),
    debug: mock(),
  },
}));

const mockFs = fs as any;

describe('Character Loader', () => {
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

  describe('tryLoadFile', () => {
    test('should load file content successfully', () => {
      const fileContent = 'test file content';
      mockFs.readFileSync.mockImplementation(() => fileContent);

      const result = tryLoadFile('/path/to/file.json');
      expect(result).toBe(fileContent);
      // expect(mockFs.readFileSync).toHaveBeenCalledWith('/path/to/file.json', 'utf8'); // TODO: Fix for bun test
    });

    test('should throw error when file loading fails', () => {
      const error = new Error('File not found');
      mockFs.readFileSync.mockImplementation(() => {
        throw error;
      });

      expect(() => tryLoadFile('/nonexistent/file.json')).toThrow(
        'Error loading file /nonexistent/file.json: Error: File not found'
      );
    });
  });

  describe('loadCharacter', () => {
    test('should load and validate character from file', async () => {
      const characterJson = JSON.stringify(validCharacter);
      mockFs.readFileSync.mockImplementation(() => characterJson);

      const result = await loadCharacter('/path/to/character.json');
      expect(result).toEqual(expect.objectContaining(validCharacter));
    });

    test('should throw error for non-existent file', async () => {
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      await expect(loadCharacter('/nonexistent/character.json')).rejects.toThrow(
        'Error loading file /nonexistent/character.json'
      );
    });

    test('should throw error for invalid JSON', async () => {
      const invalidJson = '{ "name": "Test", "bio": "Test" '; // Missing closing brace
      mockFs.readFileSync.mockImplementation(() => invalidJson);

      await expect(loadCharacter('/path/to/invalid.json')).rejects.toThrow('Invalid JSON');
    });

    test('should throw error for invalid character data', async () => {
      const invalidCharacter = JSON.stringify({ name: '', bio: 'Invalid' });
      mockFs.readFileSync.mockImplementation(() => invalidCharacter);

      await expect(loadCharacter('/path/to/invalid-character.json')).rejects.toThrow(
        'Character validation failed'
      );
    });

    test('should throw error for missing required fields', async () => {
      const incompleteCharacter = JSON.stringify({ name: 'Test' }); // Missing bio
      mockFs.readFileSync.mockImplementation(() => incompleteCharacter);

      await expect(loadCharacter('/path/to/incomplete.json')).rejects.toThrow(
        'Character validation failed'
      );
    });
  });

  describe('jsonToCharacter', () => {
    test('should validate and return character', async () => {
      const result = await jsonToCharacter(validCharacter);
      expect(result).toEqual(expect.objectContaining(validCharacter));
    });

    test('should throw error for invalid character data', async () => {
      const invalidCharacter = { name: '', bio: 'Invalid' };
      await expect(jsonToCharacter(invalidCharacter)).rejects.toThrow(
        'Character validation failed'
      );
    });

    test('should handle environment-based settings', async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        'CHARACTER.TEST_CHARACTER.API_KEY': 'test-key',
        'CHARACTER.TEST_CHARACTER.DEBUG': 'true',
      };

      const characterWithName = {
        ...validCharacter,
        name: 'Test Character',
      };

      const result = await jsonToCharacter(characterWithName);
      expect(result.secrets).toEqual(
        expect.objectContaining({
          API_KEY: 'test-key',
          DEBUG: 'true',
        })
      );

      process.env = originalEnv;
    });

    test('should handle character without environment settings', async () => {
      const originalEnv = process.env;
      // Clear any environment variables that might match
      process.env = {};

      const result = await jsonToCharacter(validCharacter);
      expect(result).toEqual(expect.objectContaining(validCharacter));

      process.env = originalEnv;
    });

    test('should validate character with complex data structures', async () => {
      const complexCharacter = {
        name: 'Complex Character',
        bio: ['Multi-line', 'bio description'],
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
        knowledge: [
          'simple/path.txt',
          { path: 'complex/path.txt', shared: true },
          { directory: 'knowledge/dir', shared: false },
        ],
        settings: {
          temperature: 0.7,
          nested: { deeply: { value: 'test' } },
        },
        style: {
          all: ['casual'],
          chat: ['responsive'],
          post: ['engaging'],
        },
      };

      const result = await jsonToCharacter(complexCharacter);
      expect(result).toEqual(expect.objectContaining(complexCharacter));
    });
  });

  describe('loadCharactersFromUrl', () => {
    const mockFetch = mock();
    global.fetch = mockFetch;

    beforeEach(() => {
      mockFetch /* .mockClear() - TODO: bun equivalent */;
    });

    test('should load single character from URL', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(validCharacter),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await loadCharactersFromUrl('https://example.com/character.json');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining(validCharacter));
    });

    test('should load multiple characters from URL', async () => {
      const characters = [validCharacter, { ...validCharacter, name: 'Second Character' }];
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(characters),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await loadCharactersFromUrl(TEST_MULTI_CHARACTER_URL);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expect.objectContaining(validCharacter));
      expect(result[1].name).toBe('Second Character');
    });

    test('should handle HTTP errors', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(loadCharactersFromUrl('https://example.com/notfound.json')).rejects.toThrow(
        'HTTP error 404: Not Found'
      );
    });

    test('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new TypeError('Network error'));

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Failed to fetch character from URL'
      );
    });

    test('should handle invalid JSON response', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(loadCharactersFromUrl('https://example.com/invalid.json')).rejects.toThrow(
        'Invalid JSON response from URL'
      );
    });

    test('should handle invalid character data from URL', async () => {
      const invalidCharacter = { name: '', bio: 'Invalid' };
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(invalidCharacter),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        loadCharactersFromUrl('https://example.com/invalid-character.json')
      ).rejects.toThrow('Invalid character data from URL');
    });

    test('should handle validation errors for array of characters', async () => {
      const characters = [validCharacter, { name: '', bio: 'Invalid' }];
      const mockResponse = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(characters),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        loadCharactersFromUrl('https://example.com/mixed-characters.json')
      ).rejects.toThrow('Character validation failed');
    });
  });

  describe('Error handling and logging', () => {
    test('should provide detailed validation error messages', async () => {
      const characterMissingName = JSON.stringify({ bio: 'No name' });
      mockFs.readFileSync.mockImplementation(() => characterMissingName);

      try {
        await loadCharacter('/path/to/no-name.json');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toContain('Character validation failed');
        expect(error.message).toContain('name');
      }
    });
  });
});
