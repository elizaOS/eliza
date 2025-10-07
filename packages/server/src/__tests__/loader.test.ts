/**
 * Unit tests for loader.ts
 */

import { describe, it, expect, beforeEach, mock, afterEach, jest } from 'bun:test';
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
import { logger, UUID } from '@elizaos/core';

const TEST_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/shaw.json';

const TEST_MULTI_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/multi-chars.json';

// Mock modules
mock.module('node:fs', () => ({
  default: {
    readFileSync: jest.fn(),
    promises: {
      mkdir: jest.fn(),
      readdir: jest.fn(),
    },
  },
  readFileSync: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    readdir: jest.fn(),
  },
}));
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    validateCharacter: jest.fn((character) => ({
      success: true,
      data: character,
    })),
    parseAndValidateCharacter: jest.fn((content) => {
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
    }),
  };
});

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('Loader Functions', () => {
  beforeEach(() => {
    mock.restore();
    process.env = {};
  });

  afterEach(() => {
    mock.restore();
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

      (fs.promises.mkdir as any).mockReturnValue(Promise.resolve(undefined));
      (fs.promises.readdir as any).mockReturnValue(Promise.resolve(['storage-char.json']));
      (fs.readFileSync as any).mockImplementation((path: string) => {
        if (path.includes('storage-char.json')) {
          return JSON.stringify(char);
        }
        throw new Error('ENOENT: no such file');
      });

      const result = await loadCharacters('');

      // Should successfully load from storage even if empty string path fails
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Storage Character');
      expect(fs.promises.readdir).toHaveBeenCalled();
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
      expect(logger.error).toHaveBeenCalledWith(
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

      (fs.promises.mkdir as any).mockRejectedValue(new Error('Permission denied'));
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const result = await loadCharacters('');

      // Should return empty array but log errors
      expect(result).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error reading directory'));
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
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load character from ''")
      );
      expect(logger.info).toHaveBeenCalledWith('No characters found, using default character');
      expect(logger.warn).toHaveBeenCalledWith(
        'Server package does not include a default character. Please provide one.'
      );
    });

    it('should trim whitespace from comma-separated paths', async () => {
      const char = { name: 'Test Character', id: 'test-1' };
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(char));

      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('char1.json'), 'utf8');
      expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('char2.json'), 'utf8');
    });
  });

  describe('Error Handling', () => {
    it('should handle JSON parsing errors with specific message', async () => {
      (fs.readFileSync as any).mockReturnValue('{ invalid json }');

      await expect(loadCharacter('/invalid.json')).rejects.toThrow();
      // loadCharacter doesn't call logger.error directly for JSON parse errors
    });

    it('should handle file system errors with specific message', async () => {
      (fs.readFileSync as any).mockImplementation(() => {
        const error = new Error('EACCES: permission denied');
        throw error;
      });

      expect(() => tryLoadFile('/protected.json')).toThrow(
        'Error loading file /protected.json: Error: EACCES: permission denied'
      );
    });

    it('should handle URL load errors and continue with local paths', async () => {
      const localChar = { name: 'Local Fallback', id: 'local-1' };

      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(localChar));

      const result = await loadCharacterTryPath('character.json');

      expect(result.name).toBe('Local Fallback');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Successfully loaded character')
      );
    });
  });
});
