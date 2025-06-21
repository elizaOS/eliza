import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeChangeDirectory } from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { existsSync } from 'fs';

describe('ElizaOS Plugin Commands', () => {
  let testTmpDir: string;
  let projectDir: string;
  let elizaosCmd: string;
  let originalCwd: string;

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-plugins-'));

    // Setup CLI command
    const scriptDir = join(__dirname, '..');
    const cliPath = join(scriptDir, '../dist/index.js');
    
    // Check if CLI is built, if not build it
    if (!existsSync(cliPath)) {
      console.log('CLI not built, building now...');
      const cliPackageDir = join(scriptDir, '..');
      execSync('bun run build', { 
        cwd: cliPackageDir,
        stdio: 'inherit'
      });
    }
    
    elizaosCmd = `bun "${cliPath}"`;

    // Create one test project for all plugin tests to share
    projectDir = join(testTmpDir, 'shared-test-project');
    process.chdir(testTmpDir);

    console.log('Creating shared test project...');

    // Create the project directory first
    const fs = await import('fs/promises');
    await fs.mkdir(projectDir, { recursive: true });

    // Create a minimal project without workspace dependencies
    await writeFile(
      join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'test-project',
          version: '1.0.0',
          type: 'module',
          dependencies: {},
        },
        null,
        2
      )
    );

    // Change to project directory for all tests
    process.chdir(projectDir);
    console.log('Shared test project created at:', projectDir);
  });

  beforeEach(() => {
    // Ensure we're in the project directory for each test
    process.chdir(projectDir);
  });

  afterAll(async () => {
    // Restore original working directory
    safeChangeDirectory(originalCwd);

    // Cleanup the temporary directory
    if (testTmpDir && testTmpDir.includes('eliza-test-plugins-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // Core help / list tests
  it('plugins command shows help with no subcommand', () => {
    const result = execSync(`${elizaosCmd} plugins`, { encoding: 'utf8' });
    expect(result).toContain('Manage ElizaOS plugins');
    expect(result).toContain('Commands:');
    expect(result).toContain('list');
    expect(result).toContain('add');
    expect(result).toContain('installed-plugins');
    expect(result).toContain('remove');
  });

  it('plugins --help shows usage information', () => {
    const result = execSync(`${elizaosCmd} plugins --help`, { encoding: 'utf8' });
    expect(result).toContain('Manage ElizaOS plugins');
  });

  it('plugins list shows available plugins', () => {
    const result = execSync(`${elizaosCmd} plugins list`, { encoding: 'utf8' });
    expect(result).toContain('Available v1.x plugins');
    // Check for plugins that actually exist in the registry
    expect(result).toMatch(/plugin-/);
  });

  it('plugins list aliases (l, ls) work correctly', () => {
    const aliases = ['l', 'ls'];

    for (const alias of aliases) {
      const result = execSync(`${elizaosCmd} plugins ${alias}`, { encoding: 'utf8' });
      expect(result).toContain('Available v1.x plugins');
      expect(result).toContain('plugins');
    }
  });

  // add / install tests - using packages from npm
  it(
    'plugins add installs a package from npm',
    async () => {
      // Test with a real npm package (dotenv is commonly used)
      execSync(`${elizaosCmd} plugins add dotenv --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
      });

      const packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).toContain('dotenv');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins install alias works with npm package',
    async () => {
      // Test with another npm package
      execSync(`${elizaosCmd} plugins install commander --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
      });

      const packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).toContain('commander');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins add supports third-party plugins from npm',
    async () => {
      // Test with another real npm package
      execSync(`${elizaosCmd} plugins add yargs --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
      });

      const packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).toContain('yargs');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins add supports GitHub URL installation',
    async () => {
      // Test with a real GitHub repository
      execSync(`${elizaosCmd} plugins add github:sindresorhus/slugify --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
      });

      const packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).toContain('slugify');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // installed-plugins list tests
  it(
    'plugins installed-plugins shows installed plugins',
    async () => {
      const result = execSync(`${elizaosCmd} plugins installed-plugins`, { encoding: 'utf8' });
      // The packages we installed (dotenv, commander, yargs) are not "plugin-" packages
      // so they won't show up in the installed plugins list
      expect(result).toContain('No Eliza plugins found');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // remove / aliases tests
  it(
    'plugins remove uninstalls a plugin',
    async () => {
      // First install a plugin
      execSync(`${elizaosCmd} plugins add chalk --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
      });

      let packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).toContain('chalk');

      // Then remove it
      execSync(`${elizaosCmd} plugins remove chalk`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
      });

      packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).not.toContain('chalk');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins remove aliases (delete, del, rm) work',
    async () => {
      // Install some simple npm packages for testing
      const testPackages = ['is-odd', 'is-even', 'is-number'];

      // Add all packages first
      for (const pkg of testPackages) {
        execSync(`${elizaosCmd} plugins add ${pkg} --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
        });
      }

      // Test different remove aliases
      const removeCommands = [
        ['delete', 'is-odd'],
        ['del', 'is-even'],
        ['rm', 'is-number'],
      ];

      for (const [command, pkg] of removeCommands) {
        execSync(`${elizaosCmd} plugins ${command} ${pkg}`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
        });
      }

      const packageJson = await readFile('package.json', 'utf8');
      for (const pkg of testPackages) {
        expect(packageJson).not.toContain(pkg);
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // Negative case tests
  it(
    'plugins add fails for missing plugin',
    async () => {
      try {
        execSync(
          `${elizaosCmd} plugins add @this-package-definitely-does-not-exist-12345 --skip-env-prompt`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          }
        );
        expect(false).toBe(true); // Should not reach here
      } catch (e: any) {
        expect(e.status).not.toBe(0);
        const output = e.stdout?.toString() || e.stderr?.toString() || '';
        expect(output).toMatch(/not found|Failed|error/i);
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins add via GitHub shorthand URL',
    async () => {
      execSync(`${elizaosCmd} plugins add github:sindresorhus/p-limit --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
      });

      const packageJson = await readFile('package.json', 'utf8');
      expect(packageJson).toContain('p-limit');
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );
});
