/**
 * Unit tests for utility functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { expandTildePath, resolvePgliteDir } from '../../../index';
import {
  setupTestEnvironment,
  teardownTestEnvironment,
  type EnvironmentSnapshot,
} from '../../test-utils/environment';
import path from 'node:path';

describe('Utility Functions', () => {
  let envSnapshot: EnvironmentSnapshot;

  beforeEach(() => {
    envSnapshot = setupTestEnvironment();
  });

  afterEach(async () => {
    await teardownTestEnvironment(envSnapshot);
  });

  describe('expandTildePath', () => {
    it('should expand tilde path to current working directory', () => {
      const input = '~/test/path';
      const expected = path.join(process.cwd(), 'test/path');

      const result = expandTildePath(input);

      expect(result).toBe(expected);
    });

    it('should return absolute path unchanged', () => {
      const input = '/absolute/path/test';

      const result = expandTildePath(input);

      expect(result).toBe(input);
    });

    it('should return relative path unchanged', () => {
      const input = 'relative/path/test';

      const result = expandTildePath(input);

      expect(result).toBe(input);
    });

    it('should handle empty string', () => {
      const input = '';

      const result = expandTildePath(input);

      expect(result).toBe('');
    });

    it('should handle null/undefined input', () => {
      const result1 = expandTildePath(null as any);
      const result2 = expandTildePath(undefined as any);

      expect(result1).toBeNull();
      expect(result2).toBeUndefined();
    });

    it('should handle tilde at root', () => {
      const input = '~';
      const expected = process.cwd();

      const result = expandTildePath(input);

      expect(result).toBe(expected);
    });

    it('should handle tilde with slash', () => {
      const input = '~/';
      const expected = process.cwd();

      const result = expandTildePath(input);

      expect(result).toBe(expected);
    });
  });

  describe('resolvePgliteDir', () => {
    beforeEach(() => {
      // Tests work with real filesystem
    });

    it('should use provided directory', () => {
      const customDir = '/custom/data/dir';

      const result = resolvePgliteDir(customDir);

      expect(result).toBe(customDir);
    });

    it('should use environment variable when no dir provided', () => {
      const envDir = '/env/data/dir';
      process.env.PGLITE_DATA_DIR = envDir;

      const result = resolvePgliteDir();

      expect(result).toBe(envDir);
    });

    it('should use fallback directory when provided', () => {
      const fallbackDir = '/fallback/data/dir';

      const result = resolvePgliteDir(undefined, fallbackDir);

      expect(result).toBe(fallbackDir);
    });

    it('should use default directory when no options provided', () => {
      const result = resolvePgliteDir();

      // Should return an absolute path
      expect(path.isAbsolute(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should expand tilde paths', () => {
      const tildeDir = '~/custom/data';
      const expected = path.join(process.cwd(), 'custom/data');

      const result = resolvePgliteDir(tildeDir);

      expect(result).toBe(expected);
    });

    it('should use explicit directory when provided', () => {
      const customPath = '/custom/path/.elizadb';

      const result = resolvePgliteDir(customPath);

      expect(result).toBe(customPath);
      expect(process.env.PGLITE_DATA_DIR).toBe(customPath);
    });

    it('should set PGLITE_DATA_DIR environment variable', () => {
      const customPath = '/custom/path/.elizadb';
      delete process.env.PGLITE_DATA_DIR;

      const result = resolvePgliteDir(customPath);

      expect(result).toBe(customPath);
      expect(process.env.PGLITE_DATA_DIR).toBeDefined();
    });

    it('should handle environment file loading', () => {
      // Environment file loading is handled internally
      const result = resolvePgliteDir();

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('should prefer explicit dir over environment variable', () => {
      const explicitDir = '/explicit/dir';
      process.env.PGLITE_DATA_DIR = '/env/dir';

      const result = resolvePgliteDir(explicitDir);

      expect(result).toBe(explicitDir);
    });

    it('should prefer environment variable over fallback', () => {
      const envDir = '/env/data/dir';
      const fallbackDir = '/fallback/dir';
      process.env.PGLITE_DATA_DIR = envDir;
      delete process.env.ELIZA_DATABASE_DIR;

      const result = resolvePgliteDir(undefined, fallbackDir);

      // Should use env variable (may be normalized by getDatabaseDir)
      expect(result).toBe(envDir);
    });

    it('should handle empty string inputs', () => {
      delete process.env.PGLITE_DATA_DIR;
      delete process.env.ELIZA_DATABASE_DIR;

      const result = resolvePgliteDir('');

      // Empty string triggers default fallback behavior
      expect(path.isAbsolute(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle undefined inputs', () => {
      delete process.env.PGLITE_DATA_DIR;
      delete process.env.ELIZA_DATABASE_DIR;

      const result = resolvePgliteDir(undefined);

      // Should return default path from getDatabaseDir()
      expect(path.isAbsolute(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('Path Security', () => {
    it('should handle path traversal attempts in expandTildePath', () => {
      const maliciousInput = '~/../../../etc/passwd';
      const result = expandTildePath(maliciousInput);

      // Should still expand but the result shows the traversal attempt
      expect(result).toBe(path.join(process.cwd(), '../../../etc/passwd'));

      // In a real application, you'd want additional validation
      // to prevent such paths from being used
    });

    it('should handle various tilde variations', () => {
      const inputs = [
        { input: '~user/path', expected: path.join(process.cwd(), 'user/path') }, // Tilde gets expanded
        { input: '~~', expected: '~~' }, // Double tilde - not expanded since doesn't start with ~/
        { input: 'not~tilde', expected: 'not~tilde' }, // Tilde not at start
      ];

      inputs.forEach(({ input, expected }) => {
        const result = expandTildePath(input);
        expect(result).toBe(expected);
      });
    });
  });
});
