import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { hasValidRemoteUrlsAsync } from '../loader';

describe('loader utils', () => {
  describe('hasValidRemoteUrlsAsync', () => {
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

    it('should return true for valid HTTP URLs', async () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
      const result = await hasValidRemoteUrlsAsync();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(true);
    });

    it('should return false for empty URLs', async () => {
      process.env.REMOTE_CHARACTER_URLS = '';
      const result = await hasValidRemoteUrlsAsync();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should return false for non-HTTP URLs', async () => {
      process.env.REMOTE_CHARACTER_URLS = 'file:///local/path.json';
      const result = await hasValidRemoteUrlsAsync();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should return false when environment variable not set', async () => {
      const result = await hasValidRemoteUrlsAsync();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should be asynchronous and return a Promise', async () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
      const resultPromise = hasValidRemoteUrlsAsync();
      // Verify it's a Promise
      expect(resultPromise).toHaveProperty('then');
      expect(resultPromise).toHaveProperty('catch');
      expect(resultPromise).toBeInstanceOf(Promise);
      // Await the result to ensure it resolves properly
      const result = await resultPromise;
      expect(typeof result).toBe('boolean');
    });
  });
});
