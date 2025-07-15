import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeChangeDirectory } from './test-utils';
import { bunExecSync } from '../utils/bun-test-helpers';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { mock } from 'bun:test';

describe('ElizaOS Update Commands', () => {
  let testTmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-update-'));
    process.chdir(testTmpDir);
  });

  afterEach(async () => {
    // Restore original working directory (if it still exists)
    safeChangeDirectory(originalCwd);

    if (testTmpDir && testTmpDir.includes('eliza-test-update-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // Helper function to create project
  const makeProj = async (name: string) => {
    bunExecSync(`elizaos create ${name} --yes`, { encoding: 'utf8' });
    process.chdir(join(testTmpDir, name));
  };

  // --help
  it('update --help shows usage and options', async () => {
    const result = bunExecSync('elizaos update --help', { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos update');
    expect(result).toContain('--cli');
    expect(result).toContain('--packages');
    expect(result).toContain('--check');
    expect(result).toContain('--skip-build');
  });

  // Basic runs
  it(
    'update runs in a valid project',
    async () => {
      await makeProj('update-app');

      const result = bunExecSync('elizaos update', { encoding: 'utf8' });

      // Should either succeed or show success message
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available)/
      );
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'update --check works',
    async () => {
      await makeProj('update-check-app');

      const result = bunExecSync('elizaos update --check', { encoding: 'utf8' });

      expect(result).toMatch(/Version: 1\.2\.\d+/);
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'update --skip-build works',
    async () => {
      await makeProj('update-skip-build-app');

      const result = bunExecSync('elizaos update --skip-build', { encoding: 'utf8' });

      expect(result).not.toContain('Building project');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'update --packages works',
    async () => {
      await makeProj('update-packages-app');

      const result = bunExecSync('elizaos update --packages', { encoding: 'utf8' });

      // Should either succeed or show success message
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available)/
      );
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'update --cli works outside a project',
    async () => {
      const result = bunExecSync('elizaos update --cli', { encoding: 'utf8' });

      // In monorepo context, version is "monorepo" and update behavior is different
      // Should either show success or message about installing globally
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available|install the CLI globally|CLI update is not available|CLI is already at the latest version)/
      );
    },
    TEST_TIMEOUTS.STANDARD_COMMAND
  );

  it(
    'update --cli --packages works',
    async () => {
      await makeProj('update-combined-app');

      const result = bunExecSync('elizaos update --cli --packages', { encoding: 'utf8' });

      // Should either succeed or show success message
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available)/
      );
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it.skipIf(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')(
    'update succeeds outside a project (global check)',
    async () => {
      const result = bunExecSync('elizaos update', { encoding: 'utf8' });

      // Should either show success or message about creating project
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available|create a new ElizaOS project|This appears to be an empty directory|Version: monorepo|Version: 1\.2\.\d+)/
      );
    },
    TEST_TIMEOUTS.STANDARD_COMMAND
  );

  // Non-project directory handling
  it(
    'update --packages shows helpful message in empty directory',
    async () => {
      const result = bunExecSync('elizaos update --packages', { encoding: 'utf8' });

      expect(result).toContain("This directory doesn't appear to be an ElizaOS project");
    },
    TEST_TIMEOUTS.STANDARD_COMMAND
  );

  it(
    'update --packages shows helpful message in non-elizaos project',
    async () => {
      // Create a non-ElizaOS package.json
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'some-other-project',
            version: '1.0.0',
            dependencies: {
              express: '^4.18.0',
            },
          },
          null,
          2
        )
      );

      const result = bunExecSync('elizaos update --packages', { encoding: 'utf8' });

      expect(result).toContain('some-other-project');
      expect(result).toContain('elizaos create');
    },
    TEST_TIMEOUTS.STANDARD_COMMAND
  );

  it(
    'update --packages works in elizaos project with dependencies',
    async () => {
      await makeProj('update-elizaos-project');

      // Add some ElizaOS dependencies to make it a valid project
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'test-elizaos-project',
            version: '1.0.0',
            dependencies: {
              '@elizaos/core': '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const result = bunExecSync('elizaos update --packages --check', { encoding: 'utf8' });

      expect(result).toContain('ElizaOS');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'update --packages shows message for project without elizaos dependencies',
    async () => {
      await makeProj('update-no-deps-project');

      // Create package.json without ElizaOS dependencies
      await writeFile(
        'package.json',
        JSON.stringify(
          {
            name: 'test-project',
            version: '1.0.0',
            eliza: {
              type: 'project',
            },
            dependencies: {
              express: '^4.18.0',
            },
          },
          null,
          2
        )
      );

      const result = bunExecSync('elizaos update --packages', { encoding: 'utf8' });

      expect(result).toContain('No ElizaOS packages found');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it.skipIf(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')(
    'update command should not create files in non-project directory',
    async () => {
      // Create a temporary directory that's not a project
      const tmpDir = mkdtempSync(join(tmpdir(), 'eliza-test-'));
      const currentDir = process.cwd();

      try {
        // Change to temp directory and run update command
        process.chdir(tmpDir);
        const result = bunExecSync('elizaos update', { encoding: 'utf8' });

        // Command should succeed (updates CLI only)
        // bunExecSync returns output string on success
        expect(result).toBeTruthy();

        // Verify no project files were created
        expect(existsSync(join(tmpDir, 'package.json'))).toBe(false);
        expect(existsSync(join(tmpDir, 'bun.lock'))).toBe(false);
        expect(existsSync(join(tmpDir, 'node_modules'))).toBe(false);
        expect(existsSync(join(tmpDir, 'package-lock.json'))).toBe(false);
        expect(existsSync(join(tmpDir, 'yarn.lock'))).toBe(false);

        // Output should mention CLI update, not package updates
        expect(result).toMatch(/CLI.*update|updat.*CLI|Version: monorepo|Version: 1\.2\.\d+/i);
        expect(result).not.toMatch(/packages.*installed/i);
      } finally {
        // Change back to original directory
        process.chdir(currentDir);
        // Clean up
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUTS.STANDARD_COMMAND
  );

  describe('bunx/npx detection', () => {
    it.skip('update --cli shows warning when running via bunx', () => {
      // Skip this test in monorepo context as it behaves differently
      // In monorepo, the version is "monorepo" and update logic is different
      const result = bunExecSync('elizaos update --cli', {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUN_INSTALL_CACHE_DIR: '/Users/user/.bun/install/cache',
        },
      });
      // The output includes the banner and other messages, but should contain the warning
      expect(result).toContain('CLI update is not available when running via npx or bunx');
      expect(result).toContain('bun install -g @elizaos/cli');
    });

    it.skip('update --cli shows warning when BUN_INSTALL_CACHE_DIR is set', () => {
      // Skip this test in monorepo context
      const result = bunExecSync('elizaos update --cli', {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUN_INSTALL_CACHE_DIR: '/Users/user/.bun/install/cache',
        },
      });
      expect(result).toContain('CLI update is not available when running via npx or bunx');
    });

    it.skip('update --cli shows warning when running via npx', () => {
      // Skip this test in monorepo context
      const result = bunExecSync('elizaos update --cli', {
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_execpath: '/usr/local/lib/node_modules/npm/bin/npx-cli.js',
        },
      });
      expect(result).toContain('CLI update is not available when running via npx or bunx');
    });

    it.skip('update --cli works with global bun installation', () => {
      // Simulate global bun installation
      process.argv = [
        '/Users/user/.bun/bin/bun',
        '/Users/user/.bun/install/global/@elizaos/cli/dist/index.js',
        'update',
        '--cli',
      ];
      process.env = {};

      const result = bunExecSync('elizaos update --cli', { encoding: 'utf8' });
      expect(result).not.toContain('CLI update is not available when running via npx or bunx');
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available|Checking for updates)/
      );
    });

    it.skip('update --cli works with global npm installation', () => {
      // Simulate global npm installation
      process.argv = [
        'node',
        '/usr/local/lib/node_modules/@elizaos/cli/dist/index.js',
        'update',
        '--cli',
      ];
      process.env = {};

      const result = bunExecSync('elizaos update --cli', { encoding: 'utf8' });
      expect(result).not.toContain('CLI update is not available when running via npx or bunx');
      expect(result).toMatch(
        /(Project successfully updated|Update completed|already up to date|No updates available|Checking for updates)/
      );
    });

    it.skip('update --cli works when NODE_ENV=global', () => {
      // Simulate global flag via environment
      process.argv = ['/Users/user/.bun/bin/bun', '/some/local/path/index.js', 'update', '--cli'];
      process.env = {
        NODE_ENV: 'global',
      };

      const result = bunExecSync('elizaos update --cli', { encoding: 'utf8' });
      expect(result).not.toContain('CLI update is not available when running via npx or bunx');
    });

    it(
      'update --packages still works when running via bunx',
      async () => {
        await makeProj('update-bunx-packages');

        // Simulate bunx execution by setting environment variable
        const result = bunExecSync('elizaos update --packages', {
          encoding: 'utf8',
          env: {
            ...process.env,
            BUN_INSTALL_CACHE_DIR: '/Users/user/.bun/install/cache',
          },
        });
        // Should update packages even when running via bunx
        expect(result).toMatch(
          /(Project successfully updated|Update completed|already up to date|No updates available)/
        );
      },
      TEST_TIMEOUTS.INDIVIDUAL_TEST
    );

    it.skip(
      'update (both cli and packages) shows warning but continues with packages via bunx',
      async () => {
        // Skip this test in monorepo context as it behaves differently
        await makeProj('update-bunx-both');

        // Simulate bunx execution by setting environment variable
        const result = bunExecSync('elizaos update', {
          encoding: 'utf8',
          env: {
            ...process.env,
            BUN_INSTALL_CACHE_DIR: '/Users/user/.bun/install/cache',
          },
        });
        // Should show warning about CLI but continue with packages
        expect(result).toContain('CLI update is not available when running via npx or bunx');
        expect(result).toMatch(
          /(Project successfully updated|Update completed|already up to date|No updates available|Found.*ElizaOS package)/
        );
      },
      TEST_TIMEOUTS.INDIVIDUAL_TEST
    );
  });
});
