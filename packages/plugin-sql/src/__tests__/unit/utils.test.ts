import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { expandTildePath, resolveEnvFile, resolvePgliteDir } from '../../utils';
import { isNeonDatabase } from '../../utils.node';
import * as path from 'node:path';

// Mock dotenv to prevent loading actual .env file
// In bun:test, module mocking is handled differently, but this test doesn't need it

describe('Utils', () => {
  describe('expandTildePath', () => {
    it('should expand paths starting with ~', () => {
      const result = expandTildePath('~/test/path');
      expect(result).toBe(path.join(process.cwd(), 'test/path'));
    });

    it('should return unchanged paths not starting with ~', () => {
      const result = expandTildePath('/absolute/path');
      expect(result).toBe('/absolute/path');
    });

    it('should handle empty strings', () => {
      const result = expandTildePath('');
      expect(result).toBe('');
    });

    it('should handle just tilde', () => {
      const result = expandTildePath('~');
      expect(result).toBe(process.cwd());
    });
  });

  describe('resolveEnvFile', () => {
    it('should find .env in current directory if it exists', () => {
      // This test will work with actual file system
      const result = resolveEnvFile();
      expect(result).toMatch(/\.env$/);
    });

    it('should return .env path even if not found', () => {
      const testDir = '/some/nonexistent/path';
      const result = resolveEnvFile(testDir);
      expect(result).toBe(path.join(testDir, '.env'));
    });
  });

  describe('resolvePgliteDir', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.PGLITE_DATA_DIR;
      delete process.env.PGLITE_DATA_DIR;
      // No need to clear all mocks in bun:test
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.PGLITE_DATA_DIR;
      } else {
        process.env.PGLITE_DATA_DIR = originalEnv;
      }
    });

    it('should prioritize dir argument', () => {
      const result = resolvePgliteDir('/custom/dir');
      expect(result).toBe('/custom/dir');
    });

    it('should use PGLITE_DATA_DIR env var if no dir provided', () => {
      process.env.PGLITE_DATA_DIR = '/env/pglite/dir';
      const result = resolvePgliteDir();
      expect(result).toBe('/env/pglite/dir');
    });

    it('should use default .eliza/.elizadb dir if no dir or env var', () => {
      delete process.env.PGLITE_DATA_DIR;
      const result = resolvePgliteDir();
      expect(result).toMatch(/\.eliza[/\\]\.elizadb$/);
    });

    it('should use default path if no arguments or env var', () => {
      delete process.env.PGLITE_DATA_DIR;
      const result = resolvePgliteDir();
      expect(result).toMatch(/\.eliza[/\\]\.elizadb$/);
    });

    it('should expand tilde paths', () => {
      const result = resolvePgliteDir('~/data/pglite');
      expect(result).toBe(path.join(process.cwd(), 'data/pglite'));
    });
  });

  describe('isNeonDatabase', () => {
    it('should return true for neon.tech URLs', () => {
      expect(
        isNeonDatabase('postgres://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/dbname')
      ).toBe(true);
      expect(
        isNeonDatabase(
          'postgresql://user:pass@ep-cool-name-123456.eu-central-1.aws.neon.tech/mydb?sslmode=require'
        )
      ).toBe(true);
    });

    it('should return true for neon.database URLs', () => {
      expect(isNeonDatabase('postgres://user:pass@host.neon.database/dbname')).toBe(true);
    });

    it('should return false for standard PostgreSQL URLs', () => {
      expect(isNeonDatabase('postgres://user:pass@localhost:5432/dbname')).toBe(false);
      expect(isNeonDatabase('postgresql://user:pass@127.0.0.1:5432/mydb')).toBe(false);
      expect(isNeonDatabase('postgres://user:pass@db.example.com:5432/dbname')).toBe(false);
    });

    it('should return false for other cloud PostgreSQL URLs', () => {
      expect(
        isNeonDatabase(
          'postgres://user:pass@my-cluster.cluster-xxx.us-east-1.rds.amazonaws.com:5432/dbname'
        )
      ).toBe(false);
      expect(
        isNeonDatabase('postgres://user:pass@mydb.postgres.database.azure.com:5432/mydb')
      ).toBe(false);
      expect(isNeonDatabase('postgres://user:pass@pooler.supabase.com:5432/postgres')).toBe(false);
    });

    it('should be case-sensitive', () => {
      // Neon URLs should be lowercase in practice
      expect(isNeonDatabase('postgres://user:pass@host.NEON.TECH/dbname')).toBe(false);
    });
  });
});
