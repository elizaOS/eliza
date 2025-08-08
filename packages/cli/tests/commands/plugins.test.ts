import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeChangeDirectory, getPlatformOptions } from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { bunExecSimple } from '../../src/utils/bun-exec';
import { bunExecSync } from '../utils/bun-test-helpers';

const PLUGIN_INSTALLATION_BUFFER = process.platform === 'win32' ? 30000 : 0;

describe('ElizaOS Plugin Commands', () => {
  let testTmpDir: string;
  let projectDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-plugins-'));

    // Create one test project for all plugin tests to share
    projectDir = join(testTmpDir, 'shared-test-project');
    process.chdir(testTmpDir);

    console.log('Creating shared test project...');
    bunExecSync(
      `elizaos create shared-test-project --yes`,
      getPlatformOptions({
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PROJECT_CREATION,
      })
    );

    // Change to project directory for all tests
    process.chdir(projectDir);
    console.log('Shared test project created at:', projectDir);

    // Install dependencies to ensure plugins can be verified
    console.log('Installing project dependencies...');
    await bunExecSimple('bun', ['install'], {
      timeout: TEST_TIMEOUTS.NETWORK_OPERATION,
      env: process.env,
    });
    console.log('Dependencies installed successfully');
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
    const result = bunExecSync(`elizaos plugins`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Manage ElizaOS plugins');
    expect(result).toContain('Commands:');
    expect(result).toContain('list');
    expect(result).toContain('add');
    expect(result).toContain('installed-plugins');
    expect(result).toContain('remove');
  });

  it('plugins --help shows usage information', () => {
    const result = bunExecSync(`elizaos plugins --help`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Manage ElizaOS plugins');
  });

  it('plugins list shows available plugins', () => {
    const result = bunExecSync(`elizaos plugins list`, getPlatformOptions({ encoding: 'utf8' }));
    expect(result).toContain('Available v1.x plugins');
    expect(result).toMatch(/plugin-openai/);
    expect(result).toMatch(/plugin-ollama/);
  });

  it('plugins list aliases (l, ls) work correctly', () => {
    const aliases = ['l', 'ls'];

    for (const alias of aliases) {
      const result = bunExecSync(
        `elizaos plugins ${alias}`,
        getPlatformOptions({ encoding: 'utf8' })
      );
      expect(result).toContain('Available v1.x plugins');
      expect(result).toContain('plugins');
    }
  });

  // add / install tests
  it(
    'plugins add installs a plugin',
    async () => {
      try {
        bunExecSync(`elizaos plugins add @elizaos/plugin-openai --skip-env-prompt`, {
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
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  it(
    'plugins install alias works',
    async () => {
      try {
        bunExecSync(`elizaos plugins install @elizaos/plugin-mcp --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
          cwd: projectDir,
        });

        const packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('@elizaos/plugin-mcp');
      } catch (error: any) {
        console.error('[ERROR] Plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  it(
    'plugins add supports third-party plugins',
    async () => {
      try {
        bunExecSync(`elizaos plugins add @fleek-platform/eliza-plugin-mcp --skip-env-prompt`, {
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
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  it(
    'plugins add supports GitHub URL installation',
    async () => {
      try {
        // First GitHub URL install
        bunExecSync(
          `elizaos plugins add https://github.com/elizaos-plugins/plugin-video-understanding --skip-env-prompt`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const packageJson1 = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson1).toContain('plugin-video-understanding');

        // Second GitHub URL install with shorthand syntax
        bunExecSync(
          `elizaos plugins add github:elizaos-plugins/plugin-openrouter#1.x --skip-env-prompt`,
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
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  // installed-plugins list tests
  it(
    'plugins installed-plugins shows installed plugins',
    async () => {
      const result = bunExecSync(`elizaos plugins installed-plugins`, { encoding: 'utf8' });
      // Should show previously installed plugins from other tests
      expect(result).toMatch(/@elizaos\/plugin-|github:/);
    },
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  // remove / aliases tests
  it(
    'plugins remove uninstalls a plugin',
    async () => {
      try {
        bunExecSync(`elizaos plugins add @elizaos/plugin-elevenlabs --skip-env-prompt`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
          cwd: projectDir,
        });

        let packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('@elizaos/plugin-elevenlabs');

        bunExecSync(`elizaos plugins remove @elizaos/plugin-elevenlabs`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          cwd: projectDir,
        });

        packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).not.toContain('@elizaos/plugin-elevenlabs');
      } catch (error: any) {
        console.error('[ERROR] Plugin remove failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  it(
    'plugins remove aliases (delete, del, rm) work',
    async () => {
      try {
        const plugins = [
          '@elizaos/plugin-bedrock',
          '@elizaos/plugin-knowledge',
          '@elizaos/plugin-farcaster',
        ];

        // Add all plugins first
        for (const plugin of plugins) {
          bunExecSync(`elizaos plugins add ${plugin} --skip-env-prompt`, {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          });
        }

        // Test different remove aliases
        const removeCommands = [
          ['delete', '@elizaos/plugin-bedrock'],
          ['del', '@elizaos/plugin-knowledge'],
          ['rm', '@elizaos/plugin-farcaster'],
        ];

        for (const [command, plugin] of removeCommands) {
          bunExecSync(`elizaos plugins ${command} ${plugin}`, {
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
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  // Negative case tests
  it(
    'plugins add fails for missing plugin',
    async () => {
      try {
        bunExecSync(`elizaos plugins add missing --skip-env-prompt`, {
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
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );

  it(
    'plugins add via GitHub shorthand URL',
    async () => {
      try {
        bunExecSync(
          `elizaos plugins add github:elizaos-plugins/plugin-farcaster#1.x --skip-env-prompt`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const packageJson = await readFile(join(projectDir, 'package.json'), 'utf8');
        expect(packageJson).toContain('github:elizaos-plugins/plugin-farcaster#1.x');
      } catch (error: any) {
        console.error('[ERROR] GitHub shorthand plugin installation failed:', error.message);
        console.error('[ERROR] stdout:', error.stdout?.toString() || 'none');
        console.error('[ERROR] stderr:', error.stderr?.toString() || 'none');
        throw error;
      }
    },
    TEST_TIMEOUTS.PLUGIN_INSTALLATION + PLUGIN_INSTALLATION_BUFFER // Add extra buffer for Windows CI
  );
});
