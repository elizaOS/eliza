import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeChangeDirectory, getPlatformOptions } from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';

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
    elizaosCmd = `bun "${join(scriptDir, '../dist/index.js')}"`;

    // Create one test project for all plugin tests to share
    projectDir = join(testTmpDir, 'shared-test-project');
    process.chdir(testTmpDir);

    console.log('Creating shared test project...');
    execSync(`${elizaosCmd} create shared-test-project --yes`, getPlatformOptions({
      stdio: 'pipe',
      timeout: TEST_TIMEOUTS.PROJECT_CREATION,
    }));

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
    const result = execSync(`${elizaosCmd} plugins`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Manage ElizaOS plugins');
    expect(result).toContain('Commands:');
    expect(result).toContain('list');
    expect(result).toContain('add');
    expect(result).toContain('installed-plugins');
    expect(result).toContain('remove');
  });

  it('plugins --help shows usage information', () => {
    const result = execSync(`${elizaosCmd} plugins --help`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Manage ElizaOS plugins');
  });

  it('plugins list shows available plugins', () => {
    const result = execSync(`${elizaosCmd} plugins list`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Available v1.x plugins');
    expect(result).toMatch(/plugin-openai/);
    expect(result).toMatch(/plugin-ollama/);
  });

  it('plugins list aliases (l, ls) work correctly', () => {
    const aliases = ['l', 'ls'];

    for (const alias of aliases) {
      const result = execSync(`${elizaosCmd} plugins ${alias}`, getPlatformOptions({ encoding: 'utf8' }));
      expect(result).toContain('Available v1.x plugins');
      expect(result).toContain('plugins');
    }
  });

  // add / install tests
  it(
    'plugins add installs a plugin',
    async () => {
      try {
        execSync(`${elizaosCmd} plugins add @elizaos/plugin-google-genai --skip-env-prompt --skip-verification`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
          cwd: projectDir,
        });

        const packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('@elizaos/plugin-google-genai');
      } catch (error: any) {
        console.error('[ERROR] Plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins install alias works',
    async () => {
      try {
        execSync(`${elizaosCmd} plugins install @elizaos/plugin-openai --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
          cwd: projectDir,
        });

        const packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('@elizaos/plugin-openai');
      } catch (error: any) {
        console.error('[ERROR] Plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins add supports third-party plugins',
    async () => {
      try {
        execSync(`${elizaosCmd} plugins add @fleek-platform/eliza-plugin-mcp --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
          cwd: projectDir,
        });

        const packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('@fleek-platform/eliza-plugin-mcp');
      } catch (error: any) {
        console.error('[ERROR] Plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins add supports GitHub URL installation',
    async () => {
      try {
        // First GitHub URL install
        execSync(
          `${elizaosCmd} plugins add https://github.com/elizaos-plugins/plugin-video-understanding --skip-env-prompt`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const packageJson1 = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson1).toContain('plugin-video-understanding');

        // Second GitHub URL install with shorthand syntax
        execSync(
          `${elizaosCmd} plugins add github:elizaos-plugins/plugin-openrouter#1.x --skip-env-prompt`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const packageJson2 = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson2).toContain('plugin-openrouter');
      } catch (error: any) {
        console.error('[ERROR] GitHub plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // installed-plugins list tests
  it(
    'plugins installed-plugins shows installed plugins',
    async () => {
      const result = execSync(`${elizaosCmd} plugins installed-plugins`, { encoding: 'utf8' });
      // Should show previously installed plugins from other tests
      expect(result).toMatch(/@elizaos\/plugin-|github:/);
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // remove / aliases tests
  it(
    'plugins remove uninstalls a plugin',
    async () => {
      try {
        execSync(`${elizaosCmd} plugins add @elizaos/plugin-sql --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
          cwd: projectDir,
        });

        let packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('@elizaos/plugin-sql');

        execSync(`${elizaosCmd} plugins remove @elizaos/plugin-sql`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          cwd: projectDir,
        });

        packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).not.toContain('@elizaos/plugin-sql');
      } catch (error: any) {
        console.error('[ERROR] Plugin remove failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins remove aliases (delete, del, rm) work',
    async () => {
      try {
        const plugins = [
          '@elizaos/plugin-evm',
          '@elizaos/plugin-groq',
          '@elizaos/plugin-anthropic',
        ];

        // Add all plugins first
        for (const plugin of plugins) {
          execSync(`${elizaosCmd} plugins add ${plugin} --skip-env-prompt`, {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          });
        }

        // Test different remove aliases
        const removeCommands = [
          ['delete', '@elizaos/plugin-evm'],
          ['del', '@elizaos/plugin-groq'],
          ['rm', '@elizaos/plugin-anthropic'],
        ];

        for (const [command, plugin] of removeCommands) {
          execSync(`${elizaosCmd} plugins ${command} ${plugin}`, {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
            cwd: projectDir,
          });
        }
      } catch (error: any) {
        console.error('[ERROR] Plugin remove aliases failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  // Negative case tests
  it(
    'plugins add fails for missing plugin',
    async () => {
      try {
        execSync(`${elizaosCmd} plugins add missing --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          cwd: projectDir,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (e: any) {
        expect(e.status).not.toBe(0);
        const output = e.stdout?.toString() || e.stderr?.toString() || '';
        expect(output).toMatch(/not found in registry/);
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it(
    'plugins add via GitHub shorthand URL',
    async () => {
      try {
        execSync(
          `${elizaosCmd} plugins add github:elizaos-plugins/plugin-evm#1.x --skip-env-prompt`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('github:elizaos-plugins/plugin-evm#1.x');
      } catch (error: any) {
        console.error('[ERROR] GitHub shorthand plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );
});
