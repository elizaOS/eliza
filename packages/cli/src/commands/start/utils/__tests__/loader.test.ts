import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hasValidRemoteUrls } from '../loader';

describe('loader utils', () => {
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

    it('should return false for non-HTTP URLs', () => {
      process.env.REMOTE_CHARACTER_URLS = 'file:///local/path.json';
      const result = hasValidRemoteUrls();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should return false when environment variable not set', () => {
      const result = hasValidRemoteUrls();
      expect(typeof result).toBe('boolean');
      expect(result).toBe(false);
    });

    it('should be synchronous and not return a Promise', () => {
      process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
      const result = hasValidRemoteUrls();
      // Verify it's not a Promise
      expect(result).not.toHaveProperty('then');
      expect(result).not.toHaveProperty('catch');
      expect(result).not.toBeInstanceOf(Promise);
    });
  });
});