/**
 * Unit tests for utility functions
 */

import { describe, it, expect, mock, beforeEach, jest } from 'bun:test';
import { expandTildePath, resolvePgliteDir } from '../index';
import path from 'node:path';

// Mock fs with proper default export
mock.module('node:fs', async () => {
  const actual = await import('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: jest.fn(),
    },
    existsSync: jest.fn(),
  };
});

// Mock dotenv with proper structure for default import
mock.module('dotenv', async () => {
  const actual = await import('dotenv');
  const mockConfig = jest.fn();
  return {
    ...actual,
    default: {
      config: mockConfig,
    },
    config: mockConfig,
  };
});

// Mock environment module
mock.module('../api/system/environment', () => ({
  resolveEnvFile: jest.fn(() => '.env'),
}));

describe('Utility Functions', () => {
  beforeEach(() => {
    mock.restore();
    // Reset environment variables
    delete process.env.PGLITE_DATA_DIR;
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
    beforeEach(async () => {
      const fs = await import('node:fs');
      (fs.existsSync as any).mockReturnValue(true);
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

    it('should handle environment file loading when exists', async () => {
      const fs = await import('node:fs');
      const dotenv = await import('dotenv');

      (fs.existsSync as any).mockReturnValue(true);

      resolvePgliteDir();

      expect(dotenv.default.config).toHaveBeenCalledWith({ path: '.env' });
    });

    it('should handle missing environment file gracefully', async () => {
      const fs = await import('node:fs');
      const dotenv = await import('dotenv');

      (fs.existsSync as any).mockReturnValue(false);

      resolvePgliteDir();

      expect(dotenv.default.config).not.toHaveBeenCalled();
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
      // Empty string gets passed through and expandTildePath returns it unchanged
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
