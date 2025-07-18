import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  tryLoadFile,
  tryLoadFileAsync,
  hasValidRemoteUrls,
  hasValidRemoteUrlsAsync,
} from '../../../src/commands/start/utils/loader';

// Mock the module loader to avoid actual module loading
mock.module('@/src/utils/module-loader', () => ({
  loadModule: mock(async () => ({
    tryLoadFile: (filePath: string) => {
      if (filePath === '/test/file.txt') {
        return 'test content';
      }
      if (filePath === '/empty/file.txt') {
        return null;
      }
      throw new Error(`Error loading file ${filePath}: File not found`);
    },
    hasValidRemoteUrls: () => {
      const urls = process.env.REMOTE_CHARACTER_URLS;
      return urls && urls !== '' && urls.toLowerCase().startsWith('http');
    },
  })),
  loadModuleSync: mock(() => ({
    tryLoadFile: (filePath: string) => {
      if (filePath === '/test/file.txt') {
        return 'test content';
      }
      if (filePath === '/empty/file.txt') {
        return null;
      }
      throw new Error(`Error loading file ${filePath}: File not found`);
    },
    hasValidRemoteUrls: () => {
      const urls = process.env.REMOTE_CHARACTER_URLS;
      return urls && urls !== '' && urls.toLowerCase().startsWith('http');
    },
  })),
}));

describe('loader utils - synchronous and asynchronous functions', () => {
  describe('tryLoadFile', () => {
    describe('synchronous version', () => {
      test('should load file content successfully', () => {
        const result = tryLoadFile('/test/file.txt');
        expect(result).toBe('test content');
        expect(typeof result).toBe('string');
      });

      test('should return null for empty file', () => {
        const result = tryLoadFile('/empty/file.txt');
        expect(result).toBeNull();
      });

      test('should throw error when file loading fails', () => {
        expect(() => tryLoadFile('/nonexistent/file.txt')).toThrow(
          'Error loading file /nonexistent/file.txt: File not found'
        );
      });

      test('should not return a Promise', () => {
        const result = tryLoadFile('/test/file.txt');
        expect(result).not.toHaveProperty('then');
        expect(result).not.toHaveProperty('catch');
        expect(result).not.toBeInstanceOf(Promise);
      });
    });

    describe('asynchronous version', () => {
      test('should load file content successfully', async () => {
        const result = await tryLoadFileAsync('/test/file.txt');
        expect(result).toBe('test content');
        expect(typeof result).toBe('string');
      });

      test('should return null for empty file', async () => {
        const result = await tryLoadFileAsync('/empty/file.txt');
        expect(result).toBeNull();
      });

      test('should throw error when file loading fails', async () => {
        await expect(tryLoadFileAsync('/nonexistent/file.txt')).rejects.toThrow(
          'Error loading file /nonexistent/file.txt: File not found'
        );
      });

      test('should return a Promise', () => {
        const resultPromise = tryLoadFileAsync('/test/file.txt');
        expect(resultPromise).toHaveProperty('then');
        expect(resultPromise).toHaveProperty('catch');
        expect(resultPromise).toBeInstanceOf(Promise);
      });
    });
  });

  describe('hasValidRemoteUrls', () => {
    const originalEnv = process.env.REMOTE_CHARACTER_URLS;

    beforeEach(() => {
      delete process.env.REMOTE_CHARACTER_URLS;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.REMOTE_CHARACTER_URLS = originalEnv;
      } else {
        delete process.env.REMOTE_CHARACTER_URLS;
      }
    });

    describe('synchronous version', () => {
      test('should return true for valid HTTP URLs', () => {
        process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
        const result = hasValidRemoteUrls();
        expect(result).toBe(true);
        expect(typeof result).toBe('boolean');
      });

      test('should return true for valid HTTP URLs (lowercase)', () => {
        process.env.REMOTE_CHARACTER_URLS = 'http://example.com/character.json';
        const result = hasValidRemoteUrls();
        expect(result).toBe(true);
      });

      test('should return false for empty URLs', () => {
        process.env.REMOTE_CHARACTER_URLS = '';
        const result = hasValidRemoteUrls();
        expect(result).toBe(false);
      });

      test('should return false for non-HTTP URLs', () => {
        process.env.REMOTE_CHARACTER_URLS = 'file:///local/path.json';
        const result = hasValidRemoteUrls();
        expect(result).toBe(false);
      });

      test('should return false when environment variable not set', () => {
        const result = hasValidRemoteUrls();
        expect(result).toBe(false);
      });

      test('should not return a Promise', () => {
        process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
        const result = hasValidRemoteUrls();
        expect(result).not.toHaveProperty('then');
        expect(result).not.toHaveProperty('catch');
        expect(result).not.toBeInstanceOf(Promise);
        expect(typeof result).toBe('boolean');
      });
    });

    describe('asynchronous version', () => {
      test('should return true for valid HTTP URLs', async () => {
        process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
        const result = await hasValidRemoteUrlsAsync();
        expect(result).toBe(true);
        expect(typeof result).toBe('boolean');
      });

      test('should return true for valid HTTP URLs (lowercase)', async () => {
        process.env.REMOTE_CHARACTER_URLS = 'http://example.com/character.json';
        const result = await hasValidRemoteUrlsAsync();
        expect(result).toBe(true);
      });

      test('should return false for empty URLs', async () => {
        process.env.REMOTE_CHARACTER_URLS = '';
        const result = await hasValidRemoteUrlsAsync();
        expect(result).toBe(false);
      });

      test('should return false for non-HTTP URLs', async () => {
        process.env.REMOTE_CHARACTER_URLS = 'file:///local/path.json';
        const result = await hasValidRemoteUrlsAsync();
        expect(result).toBe(false);
      });

      test('should return false when environment variable not set', async () => {
        const result = await hasValidRemoteUrlsAsync();
        expect(result).toBe(false);
      });

      test('should return a Promise', () => {
        process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
        const resultPromise = hasValidRemoteUrlsAsync();
        expect(resultPromise).toHaveProperty('then');
        expect(resultPromise).toHaveProperty('catch');
        expect(resultPromise).toBeInstanceOf(Promise);
      });
    });
  });

  describe('backward compatibility', () => {
    test('synchronous functions should maintain the same API as before', () => {
      // Test that synchronous functions work without await
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';

      const urlResult = hasValidRemoteUrls();
      expect(urlResult).toBe(true);

      const fileResult = tryLoadFile('/test/file.txt');
      expect(fileResult).toBe('test content');

      // These would fail if the functions returned Promises
      expect(urlResult === true).toBe(true);
      expect(fileResult === 'test content').toBe(true);
    });

    test('async functions should be available for new code', async () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';

      const urlResult = await hasValidRemoteUrlsAsync();
      expect(urlResult).toBe(true);

      const fileResult = await tryLoadFileAsync('/test/file.txt');
      expect(fileResult).toBe('test content');
    });
  });
});
