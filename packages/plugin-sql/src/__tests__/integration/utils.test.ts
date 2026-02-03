import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { expandTildePath, resolveEnvFile, resolvePgliteDir } from '../../utils.node';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Utils Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: () => string;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd;

    // Create a temporary directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'));
    process.cwd = () => tempDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.cwd = originalCwd;

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('expandTildePath', () => {
    it('should expand ~ to current working directory', () => {
      const result = expandTildePath('~/test/path');
      expect(result).toBe(path.join(tempDir, 'test/path'));
    });

    it('should not change paths without ~', () => {
      const absolutePath = '/absolute/path';
      expect(expandTildePath(absolutePath)).toBe(absolutePath);

      const relativePath = 'relative/path';
      expect(expandTildePath(relativePath)).toBe(relativePath);
    });

    it('should handle just ~ alone', () => {
      const result = expandTildePath('~');
      expect(result).toBe(tempDir);
    });

    it('should handle empty string', () => {
      expect(expandTildePath('')).toBe('');
    });
  });

  describe('resolveEnvFile', () => {
    it('should find .env in current directory', () => {
      // Create .env file in temp dir
      fs.writeFileSync(path.join(tempDir, '.env'), 'TEST=true');

      const result = resolveEnvFile(tempDir);
      expect(result).toBe(path.join(tempDir, '.env'));
    });

    it('should traverse up directories to find .env', () => {
      // Create nested directories
      const subDir = path.join(tempDir, 'sub', 'nested');
      fs.mkdirSync(subDir, { recursive: true });

      // Create .env in parent
      fs.writeFileSync(path.join(tempDir, '.env'), 'TEST=true');

      const result = resolveEnvFile(subDir);
      expect(result).toBe(path.join(tempDir, '.env'));
    });

    it('should return .env path in start directory if not found', () => {
      const subDir = path.join(tempDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });

      const result = resolveEnvFile(subDir);
      expect(result).toBe(path.join(subDir, '.env'));
    });

    it('should use current working directory if no startDir provided', () => {
      const result = resolveEnvFile();
      expect(result).toBe(path.join(tempDir, '.env'));
    });
  });

  describe('resolvePgliteDir', () => {
    it('should use provided dir argument', () => {
      const customDir = '/custom/dir';
      const result = resolvePgliteDir(customDir);
      expect(result).toBe(customDir);
    });

    it('should use PGLITE_DATA_DIR environment variable', () => {
      const envDir = '/env/dir';
      process.env.PGLITE_DATA_DIR = envDir;

      const result = resolvePgliteDir();
      expect(result).toBe(envDir);
    });

    it('should use fallback dir when no dir or env var', () => {
      delete process.env.PGLITE_DATA_DIR;
      const fallbackDir = '/fallback/dir';

      const result = resolvePgliteDir(undefined, fallbackDir);
      expect(result).toBe(fallbackDir);
    });

    it('should use default path when no arguments or env var', () => {
      delete process.env.PGLITE_DATA_DIR;

      const result = resolvePgliteDir();
      expect(result).toBe(path.join(tempDir, '.eliza', '.elizadb'));
    });

    it('should load .env file if it exists', () => {
      // Create .env file with PGLITE_DATA_DIR
      fs.writeFileSync(path.join(tempDir, '.env'), 'PGLITE_DATA_DIR=/from/env/file');
      delete process.env.PGLITE_DATA_DIR;

      const result = resolvePgliteDir();
      expect(process.env.PGLITE_DATA_DIR).toBe('/from/env/file' as any);
      expect(result).toBe('/from/env/file' as any);
    });

    it('should expand tilde paths', () => {
      const result = resolvePgliteDir('~/data/pglite');
      expect(result).toBe(path.join(tempDir, 'data/pglite'));
    });

    it('should migrate legacy path to new location', () => {
      // Set up to trigger legacy path
      const legacyPath = path.join(tempDir, '.elizadb');

      const result = resolvePgliteDir(legacyPath);

      // Should return new path
      expect(result).toBe(path.join(tempDir, '.eliza', '.elizadb'));
      // Should update env var
      expect(process.env.PGLITE_DATA_DIR).toBe(path.join(tempDir, '.eliza', '.elizadb'));
    });
  });
});
