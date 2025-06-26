import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeChangeDirectory, getPlatformOptions } from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';

describe('ElizaOS Plugin Commands', () => {
  let testTmpDir: string;
  let projectDir: string;
  let elizaosCmd: string;
  let originalCwd: string;
  let characterFile: string;

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
    execSync(
      `${elizaosCmd} create shared-test-project --yes`,
      getPlatformOptions({
        stdio: 'pipe',
        timeout: TEST_TIMEOUTS.PROJECT_CREATION,
      })
    );

    // Change to project directory for all tests
    process.chdir(projectDir);
    console.log('Shared test project created at:', projectDir);

    // Create a test character file
    characterFile = join(projectDir, 'test-character.json');
    const testCharacter = {
      name: 'TestAgent',
      bio: 'A test agent for plugin testing',
      description: 'A test agent for plugin testing',
      plugins: [],
      settings: {
        // Basic settings for the test character
        language: 'en',
      }
    };
    await writeFile(characterFile, JSON.stringify(testCharacter, null, 2));
    console.log('Created test character file at:', characterFile);
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
    const result = execSync(
      `${elizaosCmd} plugins --help`,
      getPlatformOptions({ encoding: 'utf8' })
    );
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
      const result = execSync(
        `${elizaosCmd} plugins ${alias}`,
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
        execSync(
          `${elizaosCmd} plugins add @elizaos/plugin-xmtp -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const characterJson = await readFile(characterFile, 'utf8');
        const character = JSON.parse(characterJson);
        expect(character.plugins).toContain('@elizaos/plugin-xmtp');
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
        execSync(
          `${elizaosCmd} plugins install @elizaos/plugin-mcp -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const characterJson = await readFile(characterFile, 'utf8');
        const character = JSON.parse(characterJson);
        expect(character.plugins).toContain('@elizaos/plugin-mcp');
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
        execSync(
          `${elizaosCmd} plugins add @fleek-platform/eliza-plugin-mcp -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const characterJson = await readFile(characterFile, 'utf8');
        const character = JSON.parse(characterJson);
        expect(character.plugins).toContain('@fleek-platform/eliza-plugin-mcp');
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
          `${elizaosCmd} plugins add https://github.com/elizaos-plugins/plugin-video-understanding -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const characterJson1 = await readFile(characterFile, 'utf8');
        const character1 = JSON.parse(characterJson1);
        expect(character1.plugins).toContain('plugin-video-understanding');

        // Second GitHub URL install with shorthand syntax
        execSync(
          `${elizaosCmd} plugins add github:elizaos-plugins/plugin-openrouter#1.x -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const characterJson2 = await readFile(characterFile, 'utf8');
        const character2 = JSON.parse(characterJson2);
        expect(character2.plugins).toContain('plugin-openrouter');
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
      const result = execSync(`${elizaosCmd} plugins installed-plugins -c test-character.json`, { 
        encoding: 'utf8',
        cwd: projectDir,
      });
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
        execSync(
          `${elizaosCmd} plugins add @elizaos/plugin-elevenlabs -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        let characterJson = await readFile(characterFile, 'utf8');
        let character = JSON.parse(characterJson);
        expect(character.plugins).toContain('@elizaos/plugin-elevenlabs');

        execSync(`${elizaosCmd} plugins remove @elizaos/plugin-elevenlabs -c test-character.json`, {
          stdio: 'pipe',
          timeout: TEST_TIMEOUTS.STANDARD_COMMAND,
          cwd: projectDir,
        });

        characterJson = await readFile(characterFile, 'utf8');
        character = JSON.parse(characterJson);
        expect(character.plugins).not.toContain('@elizaos/plugin-elevenlabs');
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
          '@elizaos/plugin-bedrock',
          '@elizaos/plugin-knowledge',
          '@elizaos/plugin-farcaster',
        ];

        // Add all plugins first
        for (const plugin of plugins) {
          execSync(`${elizaosCmd} plugins add ${plugin} -c test-character.json --skip-env-prompt --skip-verification`, {
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
          execSync(`${elizaosCmd} plugins ${command} ${plugin} -c test-character.json`, {
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
        execSync(`${elizaosCmd} plugins add missing -c test-character.json --skip-env-prompt`, {
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
          `${elizaosCmd} plugins add github:elizaos-plugins/plugin-farcaster#1.x -c test-character.json --skip-env-prompt --skip-verification`,
          {
            stdio: 'pipe',
            timeout: TEST_TIMEOUTS.PLUGIN_INSTALLATION,
            cwd: projectDir,
          }
        );

        const characterJson = await readFile(characterFile, 'utf8');
        const character = JSON.parse(characterJson);
        expect(character.plugins).toContain('plugin-farcaster');
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
