import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  hasValidRemoteUrls,
  hasValidRemoteUrlsAsync,
} from '../../../src/commands/start/utils/loader';

describe('loader utils - integration tests', () => {
  describe('hasValidRemoteUrls - real environment variable checks', () => {
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

    describe('synchronous version behavior', () => {
      test('returns boolean immediately for valid HTTPS URL', () => {
        process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
        const start = Date.now();
        const result = hasValidRemoteUrls();
        const duration = Date.now() - start;

        expect(result).toBe(true);
        expect(typeof result).toBe('boolean');
        // Synchronous call should be very fast (< 5ms)
        expect(duration).toBeLessThan(5);
      });

      test('returns boolean immediately for invalid URL', () => {
        process.env.REMOTE_CHARACTER_URLS = 'not-a-url';
        const result = hasValidRemoteUrls();

        expect(result).toBe(false);
        expect(typeof result).toBe('boolean');
      });

      test('handles multiple URLs correctly', () => {
        process.env.REMOTE_CHARACTER_URLS =
          'https://example1.com/char.json,https://example2.com/char.json';
        const result = hasValidRemoteUrls();

        expect(result).toBe(true);
      });
    });

    describe('asynchronous version behavior', () => {
      test('returns Promise that resolves to boolean for valid HTTPS URL', async () => {
        process.env.REMOTE_CHARACTER_URLS = 'https://example.com/character.json';
        const resultPromise = hasValidRemoteUrlsAsync();

        expect(resultPromise).toBeInstanceOf(Promise);

        const result = await resultPromise;
        expect(result).toBe(true);
        expect(typeof result).toBe('boolean');
      });

      test('returns Promise that resolves to boolean for invalid URL', async () => {
        process.env.REMOTE_CHARACTER_URLS = 'not-a-url';
        const result = await hasValidRemoteUrlsAsync();

        expect(result).toBe(false);
        expect(typeof result).toBe('boolean');
      });

      test('handles multiple URLs correctly', async () => {
        process.env.REMOTE_CHARACTER_URLS =
          'https://example1.com/char.json,https://example2.com/char.json';
        const result = await hasValidRemoteUrlsAsync();

        expect(result).toBe(true);
      });
    });

    describe('edge cases', () => {
      test('handles undefined environment variable', () => {
        const syncResult = hasValidRemoteUrls();
        expect(syncResult).toBe(false);
      });

      test('handles undefined environment variable (async)', async () => {
        const asyncResult = await hasValidRemoteUrlsAsync();
        expect(asyncResult).toBe(false);
      });

      test('handles empty string', () => {
        process.env.REMOTE_CHARACTER_URLS = '';

        const syncResult = hasValidRemoteUrls();
        expect(syncResult).toBe(false);
      });

      test('handles empty string (async)', async () => {
        process.env.REMOTE_CHARACTER_URLS = '';

        const asyncResult = await hasValidRemoteUrlsAsync();
        expect(asyncResult).toBe(false);
      });

      test('handles whitespace-only string', () => {
        process.env.REMOTE_CHARACTER_URLS = '   ';

        const syncResult = hasValidRemoteUrls();
        expect(syncResult).toBe(false);
      });

      test('handles whitespace-only string (async)', async () => {
        process.env.REMOTE_CHARACTER_URLS = '   ';

        const asyncResult = await hasValidRemoteUrlsAsync();
        expect(asyncResult).toBe(false);
      });
    });

    describe('URL validation patterns', () => {
      const testCases = [
        { url: 'https://example.com/file.json', expected: true, description: 'HTTPS URL' },
        { url: 'http://example.com/file.json', expected: true, description: 'HTTP URL' },
        { url: 'HTTPS://EXAMPLE.COM/FILE.JSON', expected: true, description: 'Uppercase HTTPS' },
        { url: 'HTTP://EXAMPLE.COM/FILE.JSON', expected: true, description: 'Uppercase HTTP' },
        { url: 'file:///local/path.json', expected: false, description: 'File URL' },
        { url: 'ftp://example.com/file.json', expected: false, description: 'FTP URL' },
        { url: '/local/path.json', expected: false, description: 'Local path' },
        { url: 'example.com/file.json', expected: false, description: 'No protocol' },
      ];

      testCases.forEach(({ url, expected, description }) => {
        test(`sync: ${description} should return ${expected}`, () => {
          process.env.REMOTE_CHARACTER_URLS = url;
          const result = hasValidRemoteUrls();
          expect(result).toBe(expected);
        });

        test(`async: ${description} should return ${expected}`, async () => {
          process.env.REMOTE_CHARACTER_URLS = url;
          const result = await hasValidRemoteUrlsAsync();
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('API consistency', () => {
    test('sync and async versions return same results', async () => {
      const testUrls = [
        'https://example.com/char.json',
        'http://example.com/char.json',
        'file:///local/path.json',
        'not-a-url',
        '',
        undefined,
      ];

      for (const url of testUrls) {
        if (url === undefined) {
          delete process.env.REMOTE_CHARACTER_URLS;
        } else {
          process.env.REMOTE_CHARACTER_URLS = url;
        }

        const syncResult = hasValidRemoteUrls();
        const asyncResult = await hasValidRemoteUrlsAsync();

        expect(syncResult).toBe(asyncResult);
      }
    });
  });
});
