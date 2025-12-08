/**
 * Unit tests for loader.ts
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  loadCharactersFromUrl,
  jsonToCharacter,
  hasValidRemoteUrls,
} from '../../../services/loader';
import { UUID } from '@elizaos/core';
import { createMockFetchResponse } from '../../test-utils/mocks';

const TEST_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/shaw.json';

const TEST_MULTI_CHARACTER_URL =
  'https://raw.githubusercontent.com/elizaOS/eliza/refs/heads/develop/packages/cli/tests/test-characters/multi-chars.json';

describe('Loader Functions', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env = {};
    fetchSpy = spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // tryLoadFile tests skipped - require fs mocking

  describe('loadCharactersFromUrl', () => {
    it('should load single character from URL', async () => {
      const mockCharacter = {
        name: 'Test Character',
        id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        bio: ['Test character biography'],
      };
      fetchSpy.mockResolvedValueOnce(createMockFetchResponse({ data: mockCharacter }));

      const result = await loadCharactersFromUrl('https://example.com/character.json');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Character');
      expect(fetchSpy).toHaveBeenCalledWith('https://example.com/character.json');
    });

    it('should load multiple characters from URL', async () => {
      const mockCharacters = [
        { name: 'Character 1', id: '123e4567-e89b-12d3-a456-426614174001' as UUID, bio: ['Bio 1'] },
        { name: 'Character 2', id: '123e4567-e89b-12d3-a456-426614174002' as UUID, bio: ['Bio 2'] },
      ];
      fetchSpy.mockResolvedValueOnce(createMockFetchResponse({ data: mockCharacters }));

      const result = await loadCharactersFromUrl(TEST_MULTI_CHARACTER_URL);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Character 1');
      expect(result[1].name).toBe('Character 2');
    });

    it('should throw error for HTTP error response', async () => {
      fetchSpy.mockResolvedValueOnce(
        createMockFetchResponse({ ok: false, status: 404, statusText: 'Not Found' })
      );

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Failed to load character from URL'
      );
    });

    it('should throw error for invalid JSON response', async () => {
      fetchSpy.mockResolvedValueOnce(
        createMockFetchResponse({ jsonError: new Error('Invalid JSON') })
      );

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Invalid JSON response from URL'
      );
    });

    it('should throw error for network failures', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Network error'));

      await expect(loadCharactersFromUrl('https://example.com/character.json')).rejects.toThrow(
        'Failed to fetch character from URL'
      );
    });
  });

  describe('jsonToCharacter', () => {
    it('should convert basic character JSON', async () => {
      const character = {
        name: 'Test',
        id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        bio: ['Test bio'],
      };

      const result = await jsonToCharacter(character);

      expect(result.name).toBe('Test');
      expect(result.id).toBe(character.id);
    });

    it('should inject environment secrets for character', async () => {
      const character = {
        name: 'Test Character',
        id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        bio: ['Test character bio'],
      };
      // The function only replaces spaces with underscores, not hyphens
      process.env['CHARACTER.TEST_CHARACTER.API_KEY'] = 'secret-key';
      process.env['CHARACTER.TEST_CHARACTER.ENDPOINT'] = 'https://api.example.com';

      const result = await jsonToCharacter(character);

      expect(result.secrets).toBeDefined();
      expect(result.secrets?.API_KEY).toBe('secret-key');
    });

    it('should merge existing secrets with environment secrets', async () => {
      const character = {
        name: 'Test Character',
        id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        bio: ['Test bio'],
        secrets: { EXISTING_SECRET: 'value' },
      };
      process.env['CHARACTER.TEST_CHARACTER.API_KEY'] = 'secret-key';

      const result = await jsonToCharacter(character);

      expect(result.secrets).toBeDefined();
      expect(result.secrets?.EXISTING_SECRET).toBe('value');
    });

    it('should handle character without id using name', async () => {
      const character = {
        name: 'Test Name',
        bio: ['Test character with auto-generated ID'],
      };
      process.env['CHARACTER.TEST_NAME.API_KEY'] = 'secret-key';

      const result = await jsonToCharacter(character);

      expect(result.name).toBe('Test Name');
      expect(result.id).toBeDefined(); // ID should be auto-generated
    });

    it('should not add settings property when character has no settings and no env settings', async () => {
      const character = {
        name: 'Test Character',
        id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        bio: ['Test bio'],
      };
      // No environment variables set for this character

      const result = await jsonToCharacter(character);

      expect(result.name).toBe('Test Character');
      expect(result).not.toHaveProperty('settings');
      expect(result).not.toHaveProperty('secrets');
    });

    it('should preserve existing settings when adding environment secrets', async () => {
      const character = {
        name: 'Test Character',
        id: '123e4567-e89b-12d3-a456-426614174000' as UUID,
        bio: ['Test bio'],
        settings: { existingSetting: 'value' },
      };
      process.env['CHARACTER.TEST_CHARACTER.API_KEY'] = 'secret-key';

      const result = await jsonToCharacter(character);

      expect(result.settings).toBeDefined();
      expect(result.settings?.existingSetting).toBe('value');
      expect(result.secrets).toBeDefined();
    });
  });

  // loadCharacter and loadCharacterTryPath tests skipped - require fs mocking

  /* NOTE: File system-based loading functions (loadCharacter, loadCharacterTryPath, loadCharacters)
   * are not unit tested here because:
   * 1. They require complex fs mocking that causes test hangs in Bun test runner
   * 2. They involve multiple file path resolution strategies that are difficult to mock reliably
   * 3. They are comprehensively covered by integration tests that use real file operations
   *
   * Network-based loading (loadCharactersFromUrl) IS unit tested above with fetch mocking.
   */

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
});
