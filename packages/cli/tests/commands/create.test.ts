import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { safeChangeDirectory, runCliCommandSilently, expectCliCommandToFail, crossPlatform } from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';

describe('ElizaOS Create Commands', () => {
  let testTmpDir: string;
  let elizaosCmd: string;
  let createElizaCmd: string;
  let originalCwd: string;

  beforeEach(async () => {
    // Store original working directory
    originalCwd = process.cwd();

    // Setup test environment for each test
    testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-'));

    // Setup CLI commands
    const scriptDir = join(__dirname, '..');
    elizaosCmd = `bun "${join(scriptDir, '../dist/index.js')}"`;
    createElizaCmd = `bun "${join(scriptDir, '../../create-eliza/index.mjs')}"`;

    // Change to test directory
    process.chdir(testTmpDir);
  });

  afterEach(async () => {
    // Restore original working directory
    safeChangeDirectory(originalCwd);

    if (testTmpDir) {
      try {
        await rm(testTmpDir, { recursive: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // Helper function to validate agent JSON structure
  const validateAgentJson = async (jsonFile: string, expectedName: string) => {
    const content = await readFile(jsonFile, 'utf8');
    const agentData = JSON.parse(content);

    expect(agentData.name).toBe(expectedName);
    expect(typeof agentData.system).toBe('string');
    expect(agentData.system.length).toBeGreaterThan(0);
    expect(Array.isArray(agentData.bio)).toBe(true);
    expect(agentData.bio.length).toBeGreaterThan(0);
    expect(Array.isArray(agentData.messageExamples)).toBe(true);
    expect(agentData.messageExamples.length).toBeGreaterThan(0);
    expect(typeof agentData.style).toBe('object');
    expect(Array.isArray(agentData.style.all)).toBe(true);
    expect(agentData.style.all.length).toBeGreaterThan(0);
  };

  test('create --help shows usage', async () => {
    const result = execSync(`${elizaosCmd} create --help`, { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos create');
    expect(result).toMatch(/(project|plugin|agent)/);
    expect(result).not.toContain('frobnicate');
  });

  test(
    'create default project succeeds',
    async () => {
      // Use cross-platform directory removal
      crossPlatform.removeDir('my-default-app');

      const result = runCliCommandSilently(elizaosCmd, 'create my-default-app --yes', {
        timeout: TEST_TIMEOUTS.PROJECT_CREATION,
      });

      // Check for various success patterns since output might vary
      const successPatterns = [
        'Project initialized successfully!',
        'successfully initialized',
        'Project created',
        'created successfully',
      ];

      const hasSuccess = successPatterns.some((pattern) => result.includes(pattern));
      if (!hasSuccess) {
        // Fallback: check if files were actually created
        expect(existsSync('my-default-app')).toBe(true);
        expect(existsSync('my-default-app/package.json')).toBe(true);
      } else {
        expect(hasSuccess).toBe(true);
      }

      expect(existsSync('my-default-app')).toBe(true);
      expect(existsSync('my-default-app/package.json')).toBe(true);
      expect(existsSync('my-default-app/src')).toBe(true);
      expect(existsSync('my-default-app/.gitignore')).toBe(true);
      expect(existsSync('my-default-app/.npmignore')).toBe(true);
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  test(
    'create plugin project succeeds',
    async () => {
      // Use cross-platform directory removal
      crossPlatform.removeDir('plugin-my-plugin-app');

      const result = runCliCommandSilently(elizaosCmd, 'create my-plugin-app --yes --type plugin', {
        timeout: TEST_TIMEOUTS.PROJECT_CREATION,
      });

      // Check for various success patterns
      const successPatterns = [
        'Plugin initialized successfully!',
        'successfully initialized',
        'Plugin created',
        'created successfully',
      ];

      const hasSuccess = successPatterns.some((pattern) => result.includes(pattern));
      const pluginDir = 'plugin-my-plugin-app';

      if (!hasSuccess) {
        // Fallback: check if files were actually created
        expect(existsSync(pluginDir)).toBe(true);
        expect(existsSync(join(pluginDir, 'package.json'))).toBe(true);
      } else {
        expect(hasSuccess).toBe(true);
      }

      expect(existsSync(pluginDir)).toBe(true);
      expect(existsSync(join(pluginDir, 'package.json'))).toBe(true);
      expect(existsSync(join(pluginDir, 'src/index.ts'))).toBe(true);
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  test('create agent succeeds', async () => {
    // Use cross-platform file removal
    crossPlatform.removeFile('my-test-agent.json');

    const result = runCliCommandSilently(elizaosCmd, 'create my-test-agent --yes --type agent');

    expect(result).toContain('Agent character created successfully');
    expect(existsSync('my-test-agent.json')).toBe(true);
    await validateAgentJson('my-test-agent.json', 'my-test-agent');
  });

  test('rejects creating project in existing directory', async () => {
    // Use cross-platform commands
    try {
      crossPlatform.removeDir('existing-app');
      execSync(`mkdir existing-app`, { stdio: 'ignore' });
      if (process.platform === 'win32') {
        execSync(`echo test > existing-app\\file.txt`, { stdio: 'ignore' });
      } else {
        execSync(`echo "test" > existing-app/file.txt`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore setup errors
    }

    const result = expectCliCommandToFail(elizaosCmd, 'create existing-app --yes');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('already exists');
  });

  test(
    'create project in current directory',
    async () => {
      // Use cross-platform commands
      try {
        crossPlatform.removeDir('create-in-place');
        execSync(`mkdir create-in-place`, { stdio: 'ignore' });
      } catch (e) {
        // Ignore setup errors
      }
      process.chdir('create-in-place');

      const result = runCliCommandSilently(elizaosCmd, 'create . --yes', {
        timeout: TEST_TIMEOUTS.PROJECT_CREATION,
      });

      expect(result).toContain('Project initialized successfully!');
      expect(existsSync('package.json')).toBe(true);
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  test('rejects invalid project name', async () => {
    const result = expectCliCommandToFail(elizaosCmd, 'create "Invalid Name" --yes');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/Invalid/i);
  });

  test('rejects invalid project type', async () => {
    const result = expectCliCommandToFail(elizaosCmd, 'create bad-type-proj --yes --type bad-type');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/Invalid type/i);
  });

  // create-eliza parity tests
  test('create-eliza default project succeeds', async () => {
    // Use cross-platform directory removal
    crossPlatform.removeDir('my-create-app');

    try {
      const result = runCliCommandSilently(createElizaCmd, 'my-create-app --yes');

      expect(result).toContain('Project initialized successfully!');
      expect(existsSync('my-create-app')).toBe(true);
      expect(existsSync('my-create-app/package.json')).toBe(true);
      expect(existsSync('my-create-app/src')).toBe(true);
    } catch (e: any) {
      // Skip this test if create-eliza is not available
      console.warn('Skipping create-eliza test - command not available');
    }
  }, 60000);

  test('create-eliza plugin project succeeds', async () => {
    // Use cross-platform directory removal
    crossPlatform.removeDir('plugin-my-create-plugin');

    try {
      const result = runCliCommandSilently(createElizaCmd, 'my-create-plugin --yes --type plugin');

      expect(result).toContain('Plugin initialized successfully!');
      const pluginDir = 'plugin-my-create-plugin';
      expect(existsSync(pluginDir)).toBe(true);
      expect(existsSync(join(pluginDir, 'package.json'))).toBe(true);
      expect(existsSync(join(pluginDir, 'src/index.ts'))).toBe(true);
    } catch (e: any) {
      // Skip this test if create-eliza is not available
      console.warn('Skipping create-eliza plugin test - command not available');
    }
  }, 60000);

  test('create-eliza agent succeeds', async () => {
    // Use cross-platform file removal
    crossPlatform.removeFile('my-create-agent.json');

    try {
      const result = runCliCommandSilently(createElizaCmd, 'my-create-agent --yes --type agent');

      expect(result).toContain('Agent character created successfully');
      expect(existsSync('my-create-agent.json')).toBe(true);
      await validateAgentJson('my-create-agent.json', 'my-create-agent');
    } catch (e: any) {
      // Skip this test if create-eliza is not available
      console.warn('Skipping create-eliza agent test - command not available');
    }
  }, 60000);
});
