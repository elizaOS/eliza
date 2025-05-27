// vi.unmock('../../src/utils/user-environment'); // Keep UserEnvironment globally mocked for now

import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import os from 'node:os';
import path from 'path';

// Import the type for the actual class
import type { UserEnvironment as UserEnvironmentType } from '../../src/utils/user-environment';

// Use top-level await to get the actual class implementation
const actualUserEnvModule = await vi.importActual<
  typeof import('../../src/utils/user-environment')
>('../../src/utils/user-environment');
const ActualUserEnvironment = actualUserEnvModule.UserEnvironment;

// Mock direct dependencies of the *actual* UserEnvironment class for this test file
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(), readdir: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() },
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/utils/resolve-utils', () => ({ resolveEnvFile: vi.fn() }));

// These imports will now get the mocks defined immediately above or from global setup for @elizaos/core
import { logger } from '@elizaos/core';
import fsPromises from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { execa } from 'execa';
import { resolveEnvFile } from '../../src/utils/resolve-utils';

const MOCK_PROJECT_ROOT = '/test/project';
const MOCK_MONOREPO_ROOT = '/test/monorepo';
const MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON = path.resolve(MOCK_PROJECT_ROOT, 'cli'); // Example CLI dir

describe('UserEnvironment - Testing Actual Class Logic', () => {
  let userEnvInstance: UserEnvironmentType; // Type is fine, instance creation is key

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('process', {
      ...global.process, // Preserve other process properties
      argv: [
        '/usr/bin/node',
        path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'dist', 'index.js'),
        'test-command',
      ],
      cwd: vi.fn().mockReturnValue(MOCK_PROJECT_ROOT),
    });

    // If ActualUserEnvironment is a singleton and caches its instance:
    if (typeof (ActualUserEnvironment as any)._resetInstanceForTesting === 'function') {
      (ActualUserEnvironment as any)._resetInstanceForTesting(); // Ensure this method exists on ActualUserEnvironment
    }
    userEnvInstance = ActualUserEnvironment.getInstance(); // Use the actual class to get instance
    userEnvInstance.clearCache();

    // Configure mocks for dependencies that the UserEnvironment methods will call
    (resolveEnvFile as Mock).mockReturnValue(path.join(MOCK_PROJECT_ROOT, '.env'));
    (fsPromises.readFile as Mock).mockImplementation(async (p: string) => {
      throw new Error(`fsPromises.readFile mock default: unhandled path ${p}`);
    });
    (fsPromises.readdir as Mock).mockResolvedValue([]);

    (existsSync as Mock).mockImplementation((p: string) => {
      const pStr = p.toString();
      if (pStr === path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'package.json')) return true;
      if (pStr === path.join(MOCK_PROJECT_ROOT, 'package.json')) return true;
      if (pStr.endsWith('lerna.json')) return pStr.includes(MOCK_MONOREPO_ROOT);
      if (pStr.endsWith('pnpm-workspace.yaml')) return pStr.includes(MOCK_MONOREPO_ROOT);
      return false;
    });

    (readFileSync as Mock).mockImplementation((p: string) => {
      const pStr = p.toString();
      if (pStr === path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'package.json')) {
        return JSON.stringify({ name: '@elizaos/cli', version: '0.0.0' });
      }
      if (pStr === path.join(MOCK_PROJECT_ROOT, 'package.json')) {
        return JSON.stringify({ name: 'test-project', version: '1.0.0' });
      }
      if (pStr.includes('cli-pkg-exists-broken') && pStr.endsWith('package.json')) {
        return 'this is not json';
      }
      const err = new Error(
        `ENOENT: mockReadFileSync unhandled path: ${pStr}`
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    (statSync as Mock).mockImplementation((p: string) => {
      if (p.toString().includes('dist'))
        return { isDirectory: () => true, isFile: () => false } as any;
      return { isDirectory: () => false, isFile: () => true } as any;
    });

    (execSync as Mock).mockReturnValue('');
    (execa as Mock).mockResolvedValue({ stdout: '' });
  });

  describe('getInfo() - OS Information', () => {
    it('should correctly gather OS platform using the actual os module', async () => {
      const info = await userEnvInstance.getInfo(); // Calls actual getInfo()
      expect(info.os.platform).toBe(os.platform());
      // Add more specific os checks if needed
    });
  });

  describe('getInfo() - CLI Information', () => {
    it('should read CLI info from package.json if it exists', async () => {
      const info = await userEnvInstance.getInfo();
      expect(info.cli.name).toBe('@elizaos/cli');
    });

    it('should use default CLI info if package.json is not found', async () => {
      // Override existsSync for this specific test to make CLI package.json not found
      const originalExistsSync = existsSync as Mock;
      (existsSync as Mock).mockImplementation((p: string) => {
        if (p === path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'package.json')) return false;
        if (p === path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'dist', 'package.json'))
          return false;
        if (p.endsWith('lerna.json')) return p.includes(MOCK_MONOREPO_ROOT);
        if (p.endsWith('pnpm-workspace.yaml')) return p.includes(MOCK_MONOREPO_ROOT);
        return false;
      });

      userEnvInstance.clearCache(); // Clear cache to force re-evaluation
      const info = await userEnvInstance.getInfo();
      expect(info.cli.name).toBe('@elizaos/cli');
      expect(info.cli.version).toBe('0.0.0');
      (existsSync as Mock).mockImplementation(originalExistsSync); // Restore original mock behavior for this test file
    });

    it('should handle errors during package.json parsing gracefully', async () => {
      const originalReadFileSync = readFileSync as Mock;
      (readFileSync as Mock).mockImplementation((p: string) => {
        if (p === path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'package.json')) {
          return 'this is not json'; // Broken JSON
        }
        if (p === path.join(MOCK_CLI_DIR_CONTAINING_PACKAGE_JSON, 'dist', 'package.json')) {
          return 'this is not json'; // Broken JSON
        }
        const err = new Error(
          'ENOENT: mock readFileSync error for parsing test: ' + p
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      userEnvInstance.clearCache(); // Clear cache
      const info = await userEnvInstance.getInfo();
      expect(info.cli.name).toBe('@elizaos/cli');
      expect(info.cli.version).toBe('0.0.0');
      (readFileSync as Mock).mockImplementation(originalReadFileSync); // Restore
    });
  });

  // Add other focused tests for UserEnvironment methods here,
  // ensuring their dependencies are mocked as above.
});
