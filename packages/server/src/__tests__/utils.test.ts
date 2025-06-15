/**
 * Unit tests for utility functions
 */

// Mock dependencies - must be hoisted before imports
const { existsSyncMock, dotenvConfigMock } = vi.hoisted(() => {
  return {
    existsSyncMock: vi.fn(),
    dotenvConfigMock: vi.fn(),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('dotenv', () => ({
  default: {
    config: dotenvConfigMock,
  },
  config: dotenvConfigMock,
}));

vi.mock('../src/api/system/environment', () => ({
  resolveEnvFile: vi.fn(() => '.env'),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expandTildePath, resolvePgliteDir } from '../index';
import path from 'node:path';
import fs from 'node:fs';

describe('Utility Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockClear();
    dotenvConfigMock.mockClear();
    // Clear environment variables
    delete process.env.PGLITE_DATA_DIR;
  });

  describe('expandTildePath', () => {
    it('should expand tilde path to current working directory', () => {
      const input = '~/data/test';
      const expected = path.join(process.cwd(), 'data/test');

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
      const expected = process.cwd() + '/';

      const result = expandTildePath(input);

      expect(result).toBe(expected);
    });
  });

  describe('resolvePgliteDir', () => {
    const originalCwd = process.cwd();

    beforeEach(() => {
      existsSyncMock.mockReturnValue(true);
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
      const expected = path.join(process.cwd(), '.eliza', '.elizadb');

      const result = resolvePgliteDir();

      expect(result).toBe(expected);
    });

    it('should expand tilde paths', () => {
      const tildeDir = '~/custom/data';
      const expected = path.join(process.cwd(), 'custom/data');

      const result = resolvePgliteDir(tildeDir);

      expect(result).toBe(expected);
    });

    it('should migrate legacy path automatically', () => {
      const legacyPath = path.join(process.cwd(), '.elizadb');
      const expectedNewPath = path.join(process.cwd(), '.eliza', '.elizadb');

      const result = resolvePgliteDir(legacyPath);

      expect(result).toBe(expectedNewPath);
      expect(process.env.PGLITE_DATA_DIR).toBe(expectedNewPath);
    });

    it('should not migrate non-legacy paths', () => {
      const customPath = '/custom/path/.elizadb';

      const result = resolvePgliteDir(customPath);

      expect(result).toBe(customPath);
      expect(process.env.PGLITE_DATA_DIR).toBeUndefined();
    });

    it('should handle environment file loading', () => {
      // resolveEnvFile is mocked to return '.env'
      existsSyncMock.mockReturnValue(true);
      dotenvConfigMock.mockClear();

      resolvePgliteDir();

      // Just check that it was called, not the exact arguments
      expect(dotenvConfigMock).toHaveBeenCalled();
    });

    it('should handle missing environment file gracefully', () => {
      existsSyncMock.mockReturnValue(false);

      resolvePgliteDir();

      expect(dotenvConfigMock).not.toHaveBeenCalled();
    });

    it('should prefer explicit dir over environment variable', () => {
      const explicitDir = '/explicit/dir';
      process.env.PGLITE_DATA_DIR = '/env/dir';

      const result = resolvePgliteDir(explicitDir);

      expect(result).toBe(explicitDir);
    });

    it('should prefer environment variable over fallback', () => {
      const envDir = '/env/dir';
      const fallbackDir = '/fallback/dir';
      process.env.PGLITE_DATA_DIR = envDir;

      const result = resolvePgliteDir(undefined, fallbackDir);

      expect(result).toBe(envDir);
    });

    it('should handle empty string inputs', () => {
      // Empty string gets passed to expandTildePath which returns empty string
      const expected = '';

      const result = resolvePgliteDir('');

      expect(result).toBe(expected);
    });

    it('should handle null/undefined inputs', () => {
      const expected = path.join(process.cwd(), '.eliza', '.elizadb');

      const result1 = resolvePgliteDir(null as any);
      const result2 = resolvePgliteDir(undefined);

      expect(result1).toBe(expected);
      expect(result2).toBe(expected);
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
        { input: '~user/path', expected: process.cwd() + '/user/path' }, // Tilde at start gets expanded
        { input: '~~', expected: process.cwd() + '/~' }, // Double tilde - first ~ is expanded
        { input: 'not~tilde', expected: 'not~tilde' }, // Tilde not at start
      ];

      inputs.forEach(({ input, expected }) => {
        const result = expandTildePath(input);
        expect(result).toBe(expected);
      });
    });
  });
});
