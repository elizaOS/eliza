import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeChangeDirectory, runCliCommandSilently } from './test-utils';

describe('ElizaOS Update Commands', () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-update-'));
    process.chdir(testTmpDir);

    // Setup CLI command
    const scriptDir = join(__dirname, '..');
    elizaosCmd = `bun run ${join(scriptDir, '../dist/index.js')}`;
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
    runCliCommandSilently(elizaosCmd, `create ${name} --yes`, { timeout: 60000 });
    process.chdir(join(testTmpDir, name));
  };

  // --help
  test('update --help shows usage and options', () => {
    const result = execSync(`${elizaosCmd} update --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos update');
    expect(result).toContain('--cli');
    expect(result).toContain('--packages');
    expect(result).toContain('--check');
    expect(result).toContain('--skip-build');
  });

  // Basic runs
  test('update runs in a valid project', async () => {
    await makeProj('update-app');

    const result = runCliCommandSilently(elizaosCmd, 'update', { timeout: 30000 });

    // Should either succeed or show success message
    expect(result).toMatch(
      /(Project successfully updated|Update completed|already up to date|No updates available)/
    );
  }, 120000);

  test('update --check works', async () => {
    await makeProj('update-check-app');

    const result = runCliCommandSilently(elizaosCmd, 'update --check', { timeout: 30000 });

    expect(result).toMatch(/Version: 1\.0/);
  }, 120000);

  test('update --skip-build works', async () => {
    await makeProj('update-skip-build-app');

    const result = runCliCommandSilently(elizaosCmd, 'update --skip-build', { timeout: 30000 });

    expect(result).not.toContain('Building project');
  }, 120000);

  test('update --packages works', async () => {
    await makeProj('update-packages-app');

    const result = runCliCommandSilently(elizaosCmd, 'update --packages', { timeout: 30000 });

    // Should either succeed or show success message
    expect(result).toMatch(
      /(Project successfully updated|Update completed|already up to date|No updates available)/
    );
  }, 120000);

  test('update --cli works outside a project', () => {
    const result = runCliCommandSilently(elizaosCmd, 'update --cli', { timeout: 30000 });

    // Should either show success or message about installing globally
    expect(result).toMatch(
      /(Project successfully updated|Update completed|already up to date|No updates available|install the CLI globally|CLI update is not available)/
    );
  }, 60000);

  test('update --cli --packages works', async () => {
    await makeProj('update-combined-app');

    const result = runCliCommandSilently(elizaosCmd, 'update --cli --packages', { timeout: 30000 });

    // Should either succeed or show success message
    expect(result).toMatch(
      /(Project successfully updated|Update completed|already up to date|No updates available)/
    );
  }, 120000);

  test('update succeeds outside a project (global check)', () => {
    const result = runCliCommandSilently(elizaosCmd, 'update', { timeout: 30000 });

    // Should either show success or message about creating project
    expect(result).toMatch(
      /(Project successfully updated|Update completed|already up to date|No updates available|create a new ElizaOS project|This appears to be an empty directory)/
    );
  }, 60000);

  // Non-project directory handling
  test('update --packages shows helpful message in empty directory', () => {
    const result = runCliCommandSilently(elizaosCmd, 'update --packages', { timeout: 30000 });

    expect(result).toContain("This directory doesn't appear to be an ElizaOS project");
  }, 60000);

  test('update --packages shows helpful message in non-elizaos project', async () => {
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

    const result = runCliCommandSilently(elizaosCmd, 'update --packages', { timeout: 30000 });

    expect(result).toContain('some-other-project');
    expect(result).toContain('elizaos create');
  }, 60000);

  test('update --packages works in elizaos project with dependencies', async () => {
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

    const result = runCliCommandSilently(elizaosCmd, 'update --packages --check', {
      timeout: 30000,
    });

    expect(result).toContain('ElizaOS');
  }, 120000);

  test('update --packages shows message for project without elizaos dependencies', async () => {
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

    const result = runCliCommandSilently(elizaosCmd, 'update --packages', { timeout: 30000 });

    expect(result).toContain('No ElizaOS packages found');
  }, 120000);
});
