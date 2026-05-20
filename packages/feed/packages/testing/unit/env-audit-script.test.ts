import { describe, expect, it } from 'bun:test';

import {
  extractEnvExampleKeysFromText,
  extractProcessEnvKeysFromText,
  isRuntimeFilePath,
  isTestFilePath,
} from '../../../scripts/env-audit';

describe('scripts/env-audit', () => {
  describe('extractProcessEnvKeysFromText', () => {
    it('extracts dot and bracket-literal env keys', () => {
      const result = extractProcessEnvKeysFromText(`
        const a = process.env.NODE_ENV;
        const b = process.env['DATABASE_URL'];
        const c = process.env[\"NEXT_PUBLIC_APP_URL\"];
      `);

      expect(result.keys).toEqual([
        'DATABASE_URL',
        'NEXT_PUBLIC_APP_URL',
        'NODE_ENV',
      ]);
      expect(result.hasDynamicAccess).toBe(false);
    });

    it('detects dynamic env access', () => {
      const result = extractProcessEnvKeysFromText(`
        const key = 'DATABASE_URL';
        const value = process.env[key];
      `);

      expect(result.keys).toEqual([]);
      expect(result.hasDynamicAccess).toBe(true);
      expect(result.dynamicSample).toContain('process.env[');
    });
  });

  describe('extractEnvExampleKeysFromText', () => {
    it('extracts KEY= lines and ignores comments/invalid keys', () => {
      const keys = extractEnvExampleKeysFromText(`
        # comment
        DATABASE_URL=
        NEXT_PUBLIC_APP_URL=https://example.com
        not_uppercase=ignored
        INVALID-KEY=ignored
      `);

      expect(keys).toEqual(['DATABASE_URL', 'NEXT_PUBLIC_APP_URL']);
    });
  });

  describe('path classifiers', () => {
    it('classifies test paths', () => {
      expect(isTestFilePath('packages/testing/unit/foo.test.ts')).toBe(true);
      expect(isTestFilePath('packages/api/src/__tests__/bar.ts')).toBe(true);
      expect(isTestFilePath('packages/api/src/tests/bar.ts')).toBe(true);
      expect(isTestFilePath('apps/web/src/app/api/route.ts')).toBe(false);
    });

    it('classifies runtime paths', () => {
      expect(isRuntimeFilePath('apps/web/src/app/api/route.ts')).toBe(true);
      expect(isRuntimeFilePath('packages/api/src/foo.ts')).toBe(true);
      expect(isRuntimeFilePath('scripts/dev-wrapper.ts')).toBe(true);

      expect(isRuntimeFilePath('packages/testing/unit/foo.test.ts')).toBe(
        false
      );
      expect(isRuntimeFilePath('packages/examples/x/src/index.ts')).toBe(false);
      expect(isRuntimeFilePath('apps/docs/app/page.tsx')).toBe(false);
    });
  });
});
