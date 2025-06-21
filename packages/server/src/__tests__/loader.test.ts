/**
 * Unit tests for loader.ts
 */

import { describe, it, expect, beforeEach, mock, afterEach, jest } from 'bun:test';

const TEST_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/shaw.json';

const TEST_MULTI_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/multi-chars.json';

// Mock logger before imports
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// Mock validateCharacter and parseAndValidateCharacter
const mockValidateCharacter = jest.fn((character) => ({
  success: true,
  data: character,
}));

const mockParseAndValidateCharacter = jest.fn((content) => {
  try {
    const parsed = JSON.parse(content);
    return {
      success: true,
      data: parsed,
    };
  } catch (error) {
    return {
      success: false,
      error: { message: 'Invalid JSON' },
    };
  }
});

// Mock fs module
const mockReadFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdir = jest.fn();
const mockReaddir = jest.fn();

mock.module('fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    promises: {
      mkdir: mockMkdir,
      readdir: mockReaddir,
    },
  },
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  promises: {
    mkdir: mockMkdir,
    readdir: mockReaddir,
  },
}));

mock.module('node:fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    promises: {
      mkdir: mockMkdir,
      readdir: mockReaddir,
    },
  },
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  promises: {
    mkdir: mockMkdir,
    readdir: mockReaddir,
  },
}));

mock.module('@elizaos/core', () => ({
  logger: mockLogger,
  validateCharacter: mockValidateCharacter,
  parseAndValidateCharacter: mockParseAndValidateCharacter,
  UUID: undefined, // UUID is just a type
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Import after mocks are set up
import fs from 'node:fs';
import {
  tryLoadFile,
  loadCharactersFromUrl,
  jsonToCharacter,
  loadCharacter,
  loadCharacterTryPath,
  loadCharacters,
  hasValidRemoteUrls,
} from '../loader';
import { UUID } from '@elizaos/core';

describe('Loader Functions', () => {
  beforeEach(() => {
    // Clear all mocks
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.debug.mockClear();
    mockValidateCharacter.mockClear();
    mockParseAndValidateCharacter.mockClear();
    mockFetch.mockClear();
    mockReadFileSync.mockClear();
    mockExistsSync.mockClear();
    mockMkdir.mockClear();
    mockReaddir.mockClear();
    process.env = {};
  });

  afterEach(() => {
    // Clean up
  });

  describe('tryLoadFile', () => {
    it('should load file successfully', () => {
      const mockContent = 'test content';
      (fs.readFileSync as any).mockReturnValue(mockContent);

      const result = tryLoadFile('/test/path.json');

      expect(result).toBe(mockContent);
      expect(fs.readFileSync).toHaveBeenCalledWith('/test/path.json', 'utf8');
    });

    it('should throw error when file reading fails', () => {
      const error = new Error('File not found');
      (fs.readFileSync as any).mockImplementation(() => {
        throw error;
      });

      expect(() => tryLoadFile('/test/path.json')).toThrow(
        'Error loading file /test/path.json: Error: File not found'
      );
    });
  });

  describe('loadCharactersFromUrl', () => {
    it('should load single character from URL', async () => {
      const mockCharacter = { name: 'Test Character', id: 'test-1' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockCharacter,
      });

      const result = await loadCharactersFromUrl('https://example.com/character.json');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Character');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/character.json');
    });

    it('should load multiple characters from URL', async () => {
      const mockCharacters = [
        { name: 'Character 1', id: 'test-1' },
        { name: 'Character 2', id: 'test-2' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockCharacters,
      });

      const result = await loadCharactersFromUrl(TEST_MULTI_CHARACTER_URL);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Character 1');
      expect(result[1].name).toBe('Character 2');
    });

    it('should throw error for HTTP error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Failed to load character from URL'
      );
    });

    it('should throw error for invalid JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Invalid JSON response from URL'
      );
    });

    it('should throw error for network failures', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Failed to fetch character from URL'
      );
    });
  });

  describe('jsonToCharacter', () => {
    it('should convert basic character JSON', async () => {
      const character = { name: 'Test', id: 'test-1' as UUID, bio: 'Test bio' };

      const result = await jsonToCharacter(character);

      expect(result).toEqual(character);
    });

    it('should inject environment secrets for character', async () => {
      const character = { name: 'Test Character', id: 'test-char' };
      // The function only replaces spaces with underscores, not hyphens
      process.env['CHARACTER.TEST-CHAR.API_KEY'] = 'secret-key';
      process.env['CHARACTER.TEST-CHAR.ENDPOINT'] = 'https://api.example.com';

      const result = await jsonToCharacter(character);

      expect(result.secrets).toEqual({
        API_KEY: 'secret-key',
        ENDPOINT: 'https://api.example.com',
      });
    });

    it('should merge existing secrets with environment secrets', async () => {
      const character = {
        name: 'Test Character',
        id: 'test-char',
        secrets: { EXISTING_SECRET: 'value' },
      };
      process.env['CHARACTER.TEST-CHAR.API_KEY'] = 'secret-key';

      const result = await jsonToCharacter(character);

      expect(result.secrets).toEqual({
        API_KEY: 'secret-key',
        EXISTING_SECRET: 'value',
      });
    });

    it('should handle character without id using name', async () => {
      const character = { name: 'Test Name' };
      process.env['CHARACTER.TEST_NAME.API_KEY'] = 'secret-key';

      const result = await jsonToCharacter(character);

      expect(result.secrets).toEqual({
        API_KEY: 'secret-key',
      });
    });

    it('should not add settings property when character has no settings and no env settings', async () => {
      const character = { name: 'Test Character', id: 'test-char' as UUID, bio: 'Test bio' };
      // No environment variables set for this character

      const result = await jsonToCharacter(character);

      expect(result).toEqual(character);
      expect(result).not.toHaveProperty('settings');
      expect(result).not.toHaveProperty('secrets');
    });

    it('should preserve existing settings when adding environment secrets', async () => {
      const character = {
        name: 'Test Character',
        id: 'test-char',
        settings: { existingSetting: 'value' },
      };
      process.env['CHARACTER.TEST-CHAR.API_KEY'] = 'secret-key';

      const result = await jsonToCharacter(character);

      expect(result.settings).toEqual({ existingSetting: 'value' });
      expect(result.secrets).toEqual({ API_KEY: 'secret-key' });
    });
  });

  describe('loadCharacter', () => {
    it('should load character from file path', async () => {
      const mockCharacter = { name: 'Test Character', id: 'test-1' };
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockCharacter));

      const result = await loadCharacter('/path/to/character.json');

      expect(result.name).toBe('Test Character');
      expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/character.json', 'utf8');
    });

    it('should throw error when file not found', async () => {
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      await expect(loadCharacter('/nonexistent.json')).rejects.toThrow(
        'Error loading file /nonexistent.json'
      );
    });

    it('should throw error for invalid JSON', async () => {
      (fs.readFileSync as any).mockReturnValue('invalid json');

      await expect(loadCharacter('/invalid.json')).rejects.toThrow();
    });
  });

  describe('loadCharacterTryPath', () => {
    it('should load character from URL', async () => {
      const mockCharacter = { name: 'URL Character', id: 'url-1' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockCharacter,
      });

      const result = await loadCharacterTryPath('https://example.com/character.json');

      expect(result.name).toBe('URL Character');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/character.json');
    });

    it('should try multiple local paths', async () => {
      const mockCharacter = { name: 'Local Character', id: 'local-1' };

      // Mock tryLoadFile to fail a few times then succeed
      let callCount = 0;
      (fs.readFileSync as any).mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          throw new Error('ENOENT: no such file');
        }
        return JSON.stringify(mockCharacter);
      });

      const result = await loadCharacterTryPath('character');

      expect(result.name).toBe('Local Character');
      // The exact number may vary based on the paths tried
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    it('should handle .json extension correctly', async () => {
      const mockCharacter = { name: 'JSON Character', id: 'json-1' };
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(mockCharacter));

      const result = await loadCharacterTryPath('character.json');

      expect(result.name).toBe('JSON Character');
      // Should not try to add .json again
      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('character.json'),
        'utf8'
      );
    });

    it('should throw error when all paths fail', async () => {
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      await expect(loadCharacterTryPath('nonexistent')).rejects.toThrow(
        "Character 'nonexistent' not found"
      );
    });

    it('should throw specific error for URL failures', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(loadCharacterTryPath('http://fail.com/character.json')).rejects.toThrow(
        'Failed to load character from URL'
      );
    });
  });

  describe('hasValidRemoteUrls', () => {
    it('should return true for valid HTTP URLs', () => {
      process.env.REMOTE_CHARACTER_URLS = TEST_CHARACTER_URL;

      expect(hasValidRemoteUrls()).toBe(true);
    });

    it('should return false for empty URLs', () => {
      process.env.REMOTE_CHARACTER_URLS = '';

      expect(hasValidRemoteUrls()).toBeFalsy();
    });

    it('should return false for non-HTTP URLs', () => {
      process.env.REMOTE_CHARACTER_URLS = 'file:///local/path.json';

      expect(hasValidRemoteUrls()).toBeFalsy();
    });

    it('should return false when environment variable not set', () => {
      delete process.env.REMOTE_CHARACTER_URLS;

      expect(hasValidRemoteUrls()).toBeFalsy();
    });
  });

  describe('loadCharacters', () => {
    it('should load characters from comma-separated paths', async () => {
      const char1 = { name: 'Character 1', id: 'char-1' };
      const char2 = { name: 'Character 2', id: 'char-2' };

      (fs.readFileSync as any).mockImplementation((path: string) => {
        // Return character data when the right path is found
        if (path.includes('char1.json')) {
          return JSON.stringify(char1);
        } else if (path.includes('char2.json')) {
          return JSON.stringify(char2);
        }
        throw new Error('ENOENT: no such file');
      });

      const result = await loadCharacters('char1.json,char2.json');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Character 1');
      expect(result[1].name).toBe('Character 2');
    });

    it('should load characters from storage when enabled', async () => {
      process.env.USE_CHARACTER_STORAGE = 'true';
      const char = { name: 'Storage Character', id: 'storage-1' };

      mockMkdir.mockReturnValue(Promise.resolve(undefined));
      mockReaddir.mockReturnValue(Promise.resolve(['char.json']));
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.includes('char.json')) {
          return JSON.stringify(char);
        }
        throw new Error('ENOENT: no such file');
      });

      // Test with an empty string path that won't load any additional characters
      const result = await loadCharacters('');

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockReaddir).toHaveBeenCalled();
      // Should only load the character from storage
      expect(result.filter(c => c.name === 'Storage Character')).toHaveLength(1);
    });

    it('should load remote characters when local paths fail', async () => {
      process.env.REMOTE_CHARACTER_URLS = TEST_CHARACTER_URL;
      const remoteChar = { name: 'Remote Character', id: 'remote-1' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => remoteChar,
      });

      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      // Now that we fixed the bug, this should work properly
      const result = await loadCharacters('non-existent.json');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Remote Character');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load character from 'non-existent.json'")
      );
      expect(mockFetch).toHaveBeenCalledWith(TEST_CHARACTER_URL);
    });

    it('should load from both local and remote sources', async () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/remote.json';
      const localChar = { name: 'Local Character', id: 'local-1' };
      const remoteChar = { name: 'Remote Character', id: 'remote-1' };

      (fs.readFileSync as any).mockReturnValue(JSON.stringify(localChar));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => remoteChar,
      });

      const result = await loadCharacters('local.json');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Local Character');
      expect(result[1].name).toBe('Remote Character');
    });

    it('should handle storage read errors gracefully', async () => {
      process.env.USE_CHARACTER_STORAGE = 'true';

      mockMkdir.mockRejectedValue(new Error('Permission denied'));
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const result = await loadCharacters('nonexistent.json');

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith('Error reading directory: Permission denied');
      // Should also log error for the nonexistent.json file
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load character from 'nonexistent.json':")
      );
      expect(result).toHaveLength(0);
    });

    it('should log warning when no characters found', async () => {
      // Mock fs to throw for any file read
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      // Empty string still creates array with empty string which tries to load
      const result = await loadCharacters('');

      expect(result).toHaveLength(0);
      // Should log error for failed empty string load
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load character from ''")
      );
      expect(mockLogger.info).toHaveBeenCalledWith('No characters found, using default character');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Server package does not include a default character. Please provide one.'
      );
    });

    it('should trim whitespace from comma-separated paths', async () => {
      const char = { name: 'Test Character', id: 'test-1' };
      mockReadFileSync.mockReturnValue(JSON.stringify(char));
      mockExistsSync.mockReturnValue(true);

      const result = await loadCharacters(' char1.json ,  char2.json  ');

      expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('char1.json'), 'utf8');
      expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('char2.json'), 'utf8');
      expect(result).toHaveLength(2);
    });
  });

  describe('Error Handling', () => {
    it('should handle JSON parsing errors with specific message', async () => {
      mockParseAndValidateCharacter.mockReturnValueOnce({
        success: false,
        error: { message: 'Syntax error: unexpected token' },
      });
      (fs.readFileSync as any).mockReturnValue('{ invalid json }');

      await expect(loadCharacter('/invalid.json')).rejects.toThrow();
      expect(mockParseAndValidateCharacter).toHaveBeenCalled();
    });

    it('should log errors from character validation', async () => {
      mockValidateCharacter.mockReturnValueOnce({
        success: false,
        data: null,
      });
      (fs.readFileSync as any).mockReturnValue('{}');

      await expect(loadCharacter('/invalid.json')).rejects.toThrow();
    });
  });
});
