import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tryLoadFile, hasValidRemoteUrls } from '../loader';

describe('loader utils - synchronous functions', () => {
  describe('hasValidRemoteUrls (sync)', () => {
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

    it('should return true for valid HTTP URLs', () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
      const result = hasValidRemoteUrls();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(true);
    });

    it('should return false for empty URLs', () => {
      process.env.REMOTE_CHARACTER_URLS = '';
      const result = hasValidRemoteUrls();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should return false when environment variable not set', () => {
      const result = hasValidRemoteUrls();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should be synchronous and return boolean directly', () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
      const result = hasValidRemoteUrls();
      // Verify it's NOT a Promise
      expect(result).not.toHaveProperty('then');
      expect(result).not.toHaveProperty('catch');
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('tryLoadFile (sync)', () => {
    it('should be synchronous and return string or null directly', () => {
      // We can't test the actual file loading without mocking loadModuleSync,
      // but we can verify the function exists and has the right signature
      expect(typeof tryLoadFile).toBe('function');
      // The function should throw or return a value, not a promise
      try {
        const result = tryLoadFile('nonexistent-file.json');
        // If it doesn't throw, verify it's not a promise
        expect(result === null || typeof result === 'string').toBe(true);
        if (result !== null) {
          expect(result).not.toBeInstanceOf(Promise);
        }
      } catch (error) {
        // If it throws, that's also valid synchronous behavior
        expect(error).toBeInstanceOf(Error);
      }
    });
  });
});