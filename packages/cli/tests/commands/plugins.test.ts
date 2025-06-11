import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtemp, rm, readFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeChangeDirectory } from './test-utils';

describe('ElizaOS Plugin Commands', () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create temporary directory
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-plugins-'));
    process.chdir(testTmpDir);

    // Setup CLI command
    const scriptDir = join(__dirname, '..');
    elizaosCmd = `bun run ${join(scriptDir, '../dist/index.js')}`;
  });

  afterEach(async () => {
    // Restore original working directory
    safeChangeDirectory(originalCwd);

    if (testTmpDir && testTmpDir.includes('eliza-test-plugins-')) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // Helper function to create test project
  const createTestProject = async (name: string) => {
    try {
      execSync(`${elizaosCmd} create ${name} --yes`, {
        stdio: 'pipe',
        timeout: 60000, // 60 second timeout
      });

      // Verify the project was created
      const projectPath = join(testTmpDir, name);
      await access(projectPath);
      process.chdir(projectPath);
    } catch (e) {
      console.error(`Failed to create test project ${name}:`, e);
      throw e;
    }
  };

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
    await createTestProject('test-add-project');

    execSync(`${elizaosCmd} plugins add @elizaos/plugin-sql --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@elizaos/plugin-sql');
  }, 120000);

  test('plugins install alias works', async () => {
    await createTestProject('test-install-alias');

    execSync(`${elizaosCmd} plugins install @elizaos/plugin-openai --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@elizaos/plugin-openai');
  }, 120000);

  test('plugins add supports third-party plugins', async () => {
    await createTestProject('test-third-party');

    execSync(`${elizaosCmd} plugins add @fleek-platform/eliza-plugin-mcp --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@fleek-platform/eliza-plugin-mcp');
  }, 120000);

  test('plugins add supports GitHub URL installation', async () => {
    await createTestProject('test-github-url');

    execSync(
      `${elizaosCmd} plugins add https://github.com/fleek-platform/eliza-plugin-mcp --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 30000,
      }
    );

    // Test shorthand as well
    process.chdir(testTmpDir);
    await createTestProject('test-github-shorthand');

    execSync(
      `${elizaosCmd} plugins add github:elizaos-plugins/plugin-openrouter#1.x --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 30000,
      }
    );

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('github:elizaos-plugins/plugin-openrouter#1.x');
  }, 120000);

  // installed-plugins list tests
  test('plugins installed-plugins shows installed plugins', async () => {
    await createTestProject('test-installed-project');

    execSync(`${elizaosCmd} plugins add @elizaos/plugin-openai --skip-env-prompt`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    const result = execSync(`${elizaosCmd} plugins installed-plugins`, { encoding: 'utf8' });
    expect(result).toContain('@elizaos/plugin-openai');
  }, 120000);

  // remove / aliases tests
  test('plugins remove uninstalls a plugin', async () => {
    await createTestProject('test-remove-project');

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
  }, 120000);

  test('plugins remove aliases (delete, del, rm) work', async () => {
    await createTestProject('test-remove-aliases');

    const plugins = ['@elizaos/plugin-sql', '@elizaos/plugin-openai', '@elizaos/plugin-anthropic'];

    // Add all plugins first
    for (const plugin of plugins) {
      execSync(`${elizaosCmd} plugins add ${plugin} --skip-env-prompt`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    }

    // Test different remove aliases
    const removeCommands = [
      ['delete', '@elizaos/plugin-sql'],
      ['del', '@elizaos/plugin-openai'],
      ['rm', '@elizaos/plugin-anthropic'],
    ];

    for (const [command, plugin] of removeCommands) {
      execSync(`${elizaosCmd} plugins ${command} ${plugin}`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    }
  }, 120000);

  // Negative case tests
  test('plugins add fails for missing plugin', async () => {
    await createTestProject('proj-missing-plugin');

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
  }, 120000);

  // Direct GitHub URL installs
  test('plugins add via direct GitHub URL', async () => {
    await createTestProject('proj-direct-github-url');

    execSync(
      `${elizaosCmd} plugins add https://github.com/fleek-platform/eliza-plugin-mcp --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 30000,
      }
    );

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('@fleek-platform/eliza-plugin-mcp');
  }, 120000);

  test('plugins add via GitHub shorthand URL', async () => {
    await createTestProject('proj-shorthand-github-url');

    execSync(
      `${elizaosCmd} plugins add github:elizaos-plugins/plugin-openrouter#1.x --skip-env-prompt`,
      {
        stdio: 'pipe',
        timeout: 30000,
      }
    );

    const packageJson = await readFile('package.json', 'utf8');
    expect(packageJson).toContain('github:elizaos-plugins/plugin-openrouter#1.x');
  }, 120000);
});
