import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtemp, rm, readFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeChangeDirectory } from './test-utils';

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
    elizaosCmd = `bun run ${join(scriptDir, '../dist/index.js')}`;

    // Create one test project for all plugin tests to share
    projectDir = join(testTmpDir, 'shared-test-project');
    process.chdir(testTmpDir);

    console.log('Creating shared test project...');
    execSync(`${elizaosCmd} create shared-test-project --yes`, {
      stdio: 'pipe',
      timeout: 120000,
    });

    // Change to project directory for all tests
    process.chdir(projectDir);
    console.log('Shared test project created at:', projectDir);
  }, 150000); // Longer timeout for project creation

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
  test('plugins command shows help with no subcommand', () => {
    const result = execSync(`${elizaosCmd} plugins`, { encoding: 'utf8' });
    expect(result).toContain('Manage ElizaOS plugins');
    expect(result).toContain('Commands:');
    expect(result).toContain('list');
    expect(result).toContain('add');
    expect(result).toContain('installed-plugins');
    expect(result).toContain('remove');
  });

  test('plugins --help shows usage information', () => {
    const result = execSync(`${elizaosCmd} plugins --help`, { encoding: 'utf8' });
    expect(result).toContain('Manage ElizaOS plugins');
  });

  test('plugins list shows available plugins', () => {
    const result = execSync(`${elizaosCmd} plugins list`, { encoding: 'utf8' });
    expect(result).toContain('Available v1.x plugins');
    expect(result).toMatch(/plugin-openai/);
    expect(result).toMatch(/plugin-ollama/);
  });

  test('plugins list aliases (l, ls) work correctly', () => {
    const aliases = ['l', 'ls'];

    for (const alias of aliases) {
      const result = execSync(`${elizaosCmd} plugins ${alias}`, { encoding: 'utf8' });
      expect(result).toContain('Available v1.x plugins');
      expect(result).toContain('plugins');
    }
  });

  // add / install tests
  test('plugins add installs a plugin', async () => {
    execSync(`${elizaosCmd} plugins add @elizaos/plugin-telegram --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@elizaos/plugin-telegram');
  }, 40000);

  test('plugins install alias works', async () => {
    execSync(`${elizaosCmd} plugins install @elizaos/plugin-openai --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@elizaos/plugin-openai');
  }, 40000);

  test('plugins add supports third-party plugins', async () => {
    execSync(`${elizaosCmd} plugins add @fleek-platform/eliza-plugin-mcp --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@fleek-platform/eliza-plugin-mcp');
  }, 40000);

  test('plugins add supports GitHub URL installation', async () => {
    execSync(
      `${elizaosCmd} plugins add https://github.com/elizaos-plugins/plugin-video-understanding --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 60000,
      }
    );

    execSync(
      `${elizaosCmd} plugins add github:elizaos-plugins/plugin-farcaster#1.x --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 60000,
      }
    );

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('plugin-video-understanding');
    expect(packageJson).toContain('plugin-farcaster');
  }, 80000);

  // installed-plugins list tests
  test('plugins installed-plugins shows installed plugins', async () => {
    const result = execSync(`${elizaosCmd} plugins installed-plugins`, { encoding: 'utf8' });
    // Should show previously installed plugins from other tests
    expect(result).toMatch(/@elizaos\/plugin-|github:/);
  }, 40000);

  // remove / aliases tests
  test('plugins remove uninstalls a plugin', async () => {
    execSync(`${elizaosCmd} plugins add @elizaos/plugin-sql --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    let packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@elizaos/plugin-sql');

    execSync(`${elizaosCmd} plugins remove @elizaos/plugin-sql`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).not.toContain('@elizaos/plugin-sql');
  }, 40000);

  test('plugins remove aliases (delete, del, rm) work', async () => {
    const plugins = ['@elizaos/plugin-evm', '@elizaos/plugin-groq', '@elizaos/plugin-anthropic'];

    // Add all plugins first
    for (const plugin of plugins) {
      execSync(`${elizaosCmd} plugins add ${plugin} --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: 30000,
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
        timeout: 30000,
      });
    }
  }, 40000);

  // Negative case tests
  test('plugins add fails for missing plugin', async () => {
    try {
      execSync(`${elizaosCmd} plugins add missing --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      expect(false).toBe(true); // Should not reach here
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      const output = e.stdout?.toString() || e.stderr?.toString() || '';
      expect(output).toMatch(/not found in registry/);
    }
  }, 40000);


  test('plugins add via GitHub shorthand URL', async () => {
    execSync(
      `${elizaosCmd} plugins add github:elizaos-plugins/plugin-openrouter#1.x --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 30000,
      }
    );

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('github:elizaos-plugins/plugin-openrouter#1.x');
  }, 40000);
});
