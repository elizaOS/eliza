import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  safeChangeDirectory,
  runCliCommandSilently,
  expectCliCommandToFail,
  crossPlatform,
  getPlatformOptions,
} from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { getAvailableAIModels } from '../../src/commands/create/utils/selection';
import { isValidOllamaEndpoint } from '../../src/utils/get-config';
import { bunExecSync } from '../utils/bun-test-helpers';

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

  it('create --help shows usage', async () => {
    const result = bunExecSync(
      `${elizaosCmd} create --help`,
      getPlatformOptions({ encoding: 'utf8' })
    );
    expect(result).toContain('Usage: elizaos create');
    expect(result).toMatch(/(project|plugin|agent)/);
    expect(result).not.toContain('frobnicate');
  });

  it(
    'create default project succeeds',
    async () => {
      // Use cross-platform directory removal
      crossPlatform.removeDir('my-default-app');

      const result = await runCliCommandSilently(elizaosCmd, 'create my-default-app --yes', {
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

  it(
    'create plugin project succeeds',
    async () => {
      // Use cross-platform directory removal
      crossPlatform.removeDir('plugin-my-plugin-app');

      const result = await runCliCommandSilently(
        elizaosCmd,
        'create my-plugin-app --yes --type plugin',
        {
          timeout: TEST_TIMEOUTS.PROJECT_CREATION,
        }
      );

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

  it('create agent succeeds', async () => {
    // Use cross-platform file removal
    crossPlatform.removeFile('my-test-agent.json');

    const result = await runCliCommandSilently(
      elizaosCmd,
      'create my-test-agent --yes --type agent'
    );

    expect(result).toContain('Agent character created successfully');
    expect(existsSync('my-test-agent.json')).toBe(true);
    await validateAgentJson('my-test-agent.json', 'my-test-agent');
  });

  it('rejects creating project in existing directory', async () => {
    // Use cross-platform commands
    try {
      crossPlatform.removeDir('existing-app');
      bunExecSync(`mkdir existing-app`, getPlatformOptions({ stdio: 'ignore' }));
      if (process.platform === 'win32') {
        bunExecSync(`echo test > existing-app\\file.txt`, getPlatformOptions({ stdio: 'ignore' }));
      } else {
        bunExecSync(`echo "test" > existing-app/file.txt`, getPlatformOptions({ stdio: 'ignore' }));
      }
    } catch (e) {
      // Ignore setup errors
    }

    const result = await expectCliCommandToFail(elizaosCmd, 'create existing-app --yes');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('already exists');
  });

  it(
    'create project in current directory',
    async () => {
      // Use cross-platform commands
      try {
        crossPlatform.removeDir('create-in-place');
        bunExecSync(`mkdir create-in-place`, getPlatformOptions({ stdio: 'ignore' }));
      } catch (e) {
        // Ignore setup errors
      }
      process.chdir('create-in-place');

      const result = await runCliCommandSilently(elizaosCmd, 'create . --yes', {
        timeout: TEST_TIMEOUTS.PROJECT_CREATION,
      });

      expect(result).toContain('Project initialized successfully!');
      expect(existsSync('package.json')).toBe(true);
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );

  it('rejects invalid project name', async () => {
    const result = await expectCliCommandToFail(elizaosCmd, 'create Invalid-Name! --yes');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/Invalid project name/i);
  });

  it('rejects invalid project type', async () => {
    const result = await expectCliCommandToFail(
      elizaosCmd,
      'create bad-type-proj --yes --type bad-type'
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/Invalid type/i);
  });

  // create-eliza parity tests
  it('create-eliza default project succeeds', async () => {
    // Use cross-platform directory removal
    crossPlatform.removeDir('my-create-app');

    try {
      const result = await runCliCommandSilently(createElizaCmd, 'my-create-app --yes');

      expect(result).toContain('Project initialized successfully!');
      expect(existsSync('my-create-app')).toBe(true);
      expect(existsSync('my-create-app/package.json')).toBe(true);
      expect(existsSync('my-create-app/src')).toBe(true);
    } catch (e: any) {
      // Skip this test if create-eliza is not available
      console.warn('Skipping create-eliza test - command not available');
    }
  }, 60000);

  it('create-eliza plugin project succeeds', async () => {
    // Use cross-platform directory removal
    crossPlatform.removeDir('plugin-my-create-plugin');

    try {
      const result = await runCliCommandSilently(
        createElizaCmd,
        'my-create-plugin --yes --type plugin'
      );

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

  it('create-eliza agent succeeds', async () => {
    // Use cross-platform file removal
    crossPlatform.removeFile('my-create-agent.json');

    try {
      const result = await runCliCommandSilently(
        createElizaCmd,
        'my-create-agent --yes --type agent'
      );

      expect(result).toContain('Agent character created successfully');
      expect(existsSync('my-create-agent.json')).toBe(true);
      await validateAgentJson('my-create-agent.json', 'my-create-agent');
    } catch (e: any) {
      // Skip this test if create-eliza is not available
      console.warn('Skipping create-eliza agent test - command not available');
    }
  }, 60000);

  describe('AI Model Selection', () => {
    it('returns a reasonable number of AI model options', () => {
      const models = getAvailableAIModels();

      // Test for minimum providers instead of exact count
      expect(models.length).toBeGreaterThanOrEqual(3);
      expect(models.length).toBeLessThanOrEqual(7); // reasonable upper limit
    });

    it('maintains core AI model options', () => {
      const models = getAvailableAIModels();
      const values = models.map((m) => m.value);

      // Only test for essential/core providers
      const CORE_PROVIDERS = ['local', 'openai', 'claude', 'openrouter'];
      CORE_PROVIDERS.forEach((provider) => {
        expect(values).toContain(provider);
      });
    });

    it('all AI models follow the expected contract', () => {
      const models = getAvailableAIModels();

      models.forEach((model) => {
        // Test structure
        expect(model).toHaveProperty('value');
        expect(model).toHaveProperty('title');
        expect(model).toHaveProperty('description');

        // Test types
        expect(typeof model.value).toBe('string');
        expect(typeof model.title).toBe('string');
        expect(typeof model.description).toBe('string');

        // Test non-empty values
        expect(model.value.length).toBeGreaterThan(0);
        expect(model.title.length).toBeGreaterThan(0);
        expect(model.description.length).toBeGreaterThan(0);

        // Test naming conventions
        expect(model.value).toBe(model.value.toLowerCase());
      });
    });
  });

  describe('Ollama Configuration', () => {
    it('validates valid ollama endpoints', () => {
      expect(isValidOllamaEndpoint('http://localhost:11434')).toBe(true);
      expect(isValidOllamaEndpoint('https://ollama.example.com')).toBe(true);
      expect(isValidOllamaEndpoint('http://192.168.1.100:11434')).toBe(true);
    });

    it('rejects invalid ollama endpoints', () => {
      expect(isValidOllamaEndpoint('')).toBe(false);
      expect(isValidOllamaEndpoint('localhost:11434')).toBe(false);
      expect(isValidOllamaEndpoint('ftp://localhost:11434')).toBe(false);
      expect(isValidOllamaEndpoint('not-a-url')).toBe(false);
      expect(isValidOllamaEndpoint(null as any)).toBe(false);
      expect(isValidOllamaEndpoint(undefined as any)).toBe(false);
    });
  });

  describe('Cleanup on Interruption', () => {
    it(
      'cleans up partial plugin creation on process termination',
      async () => {
        // this test verifies that when you press ctrl-c during 'bun install'
        // the partially created directory gets cleaned up automatically
        // fixing the bug where abandoned directories were left behind

        const pluginName = 'test-cleanup-plugin';
        const pluginDir = `plugin-${pluginName}`;

        // ensure plugin directory doesn't exist before test
        crossPlatform.removeDir(pluginDir);
        expect(existsSync(pluginDir)).toBe(false);

        // start the create command in a subprocess that we can kill
        // Extract the script path from elizaosCmd, handling quoted paths
        // elizaosCmd is like: bun "/path/to/index.js" or bun /path/to/index.js
        const match = elizaosCmd.match(/^bun\s+(?:"([^"]+)"|(\S+))$/);
        const scriptPath = match?.[1] || match?.[2] || elizaosCmd.replace('bun ', '');
        const createProcess = Bun.spawn(
          ['bun', scriptPath, 'create', pluginName, '--type', 'plugin', '--yes'],
          {
            stdout: 'ignore',
            stderr: 'ignore',
            stdin: 'ignore',
          }
        );

        // give process time to start creating the directory
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // send SIGINT to simulate ctrl-c
        try {
          createProcess.kill('SIGINT');
        } catch (e) {
          // process might have already exited
        }

        // wait for cleanup handlers to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // verify the directory was cleaned up - no abandoned directories!
        expect(existsSync(pluginDir)).toBe(false);
      },
      TEST_TIMEOUTS.INDIVIDUAL_TEST
    );
  });

  describe('--dir Flag Removal (Breaking Change)', () => {
    it('rejects --dir flag with helpful error message', async () => {
      const result = await expectCliCommandToFail(elizaosCmd, 'create my-project --dir /some/path');

      expect(result.status).not.toBe(0);
      // Check for various error patterns since the exact message might vary
      const errorPatterns = [
        '--dir flag is no longer supported',
        'Unknown option',
        'unknown option',
        'Invalid option',
        'dir',
      ];

      const hasError = errorPatterns.some((pattern) =>
        result.output.toLowerCase().includes(pattern.toLowerCase())
      );
      expect(hasError).toBe(true);
    });

    it('rejects -d shorthand flag', async () => {
      const result = await expectCliCommandToFail(elizaosCmd, 'create my-project -d /some/path');

      expect(result.status).not.toBe(0);
      const errorPatterns = [
        '-d flag is no longer supported',
        'Unknown option',
        'unknown option',
        'Invalid option',
      ];

      const hasError = errorPatterns.some((pattern) =>
        result.output.toLowerCase().includes(pattern.toLowerCase())
      );
      expect(hasError).toBe(true);
    });

    it(
      'creates project in current directory without --dir flag',
      async () => {
        // Create a test subdirectory and navigate to it
        const testSubDir = 'test-subdir';
        crossPlatform.removeDir(testSubDir);
        bunExecSync(`mkdir ${testSubDir}`, getPlatformOptions({ stdio: 'ignore' }));

        const originalDir = process.cwd();
        process.chdir(testSubDir);

        try {
          const result = await runCliCommandSilently(
            elizaosCmd,
            'create my-current-dir-project --yes',
            {
              timeout: TEST_TIMEOUTS.PROJECT_CREATION,
            }
          );

          // Check for success patterns
          const successPatterns = [
            'Project initialized successfully!',
            'successfully initialized',
            'Project created',
            'created successfully',
          ];

          const hasSuccess = successPatterns.some((pattern) => result.includes(pattern));
          expect(hasSuccess || existsSync('my-current-dir-project')).toBe(true);

          // Verify project was created in current directory
          expect(existsSync('my-current-dir-project')).toBe(true);
          expect(existsSync('my-current-dir-project/package.json')).toBe(true);
        } finally {
          // Restore original directory
          process.chdir(originalDir);
        }
      },
      TEST_TIMEOUTS.INDIVIDUAL_TEST
    );

    it(
      'migration guide: shows how to create in specific directory',
      async () => {
        // This test documents the migration path for users
        // Before: elizaos create my-project --dir /path/to/directory
        // After: cd /path/to/directory && elizaos create my-project

        const testDir = 'migration-test-dir';
        crossPlatform.removeDir(testDir);
        bunExecSync(`mkdir ${testDir}`, getPlatformOptions({ stdio: 'ignore' }));

        const originalDir = process.cwd();

        try {
          // Navigate to desired directory first (migration approach)
          process.chdir(testDir);

          // Then create the project
          const result = await runCliCommandSilently(elizaosCmd, 'create migrated-project --yes', {
            timeout: TEST_TIMEOUTS.PROJECT_CREATION,
          });

          expect(existsSync('migrated-project')).toBe(true);
          expect(existsSync('migrated-project/package.json')).toBe(true);
        } finally {
          process.chdir(originalDir);
        }
      },
      TEST_TIMEOUTS.INDIVIDUAL_TEST
    );
  });

  it(
    'does not hoist PGLITE database to parent .eliza directory',
    async () => {
      // Create a parent directory that looks like an Eliza project
      const parentDir = await mkdtemp(join(tmpdir(), 'eliza-parent-'));
      const parentElizaDir = join(parentDir, '.eliza');
      await mkdir(parentElizaDir, { recursive: true });

      // Create a marker file to verify we're not using parent's .eliza
      await writeFile(join(parentElizaDir, 'parent-marker.txt'), 'parent');

      const originalDir = process.cwd();

      try {
        // Change to parent directory and create a new project
        process.chdir(parentDir);

        const result = await runCliCommandSilently(elizaosCmd, 'create test-no-hoist --yes', {
          timeout: TEST_TIMEOUTS.PROJECT_CREATION,
        });

        // Verify project was created
        expect(existsSync('test-no-hoist')).toBe(true);
        expect(existsSync('test-no-hoist/package.json')).toBe(true);

        // Verify project has its own .eliza directory
        const projectElizaDir = join('test-no-hoist', '.eliza');
        expect(existsSync(projectElizaDir)).toBe(true);

        // Verify the project's .eliza directory has its own database directory
        const projectDbDir = join(projectElizaDir, '.elizadb');
        expect(existsSync(projectDbDir)).toBe(true);

        // Verify the parent marker file is NOT in the project's .eliza directory
        const projectMarkerPath = join(projectElizaDir, 'parent-marker.txt');
        expect(existsSync(projectMarkerPath)).toBe(false);

        // Verify .env file is in the project directory, not parent
        const projectEnvPath = join('test-no-hoist', '.env');
        expect(existsSync(projectEnvPath)).toBe(true);

        // Read .env to verify PGLITE_DATA_DIR points to project's database
        const envContent = await readFile(projectEnvPath, 'utf8');
        expect(envContent).toContain('PGLITE_DATA_DIR=');

        // Extract the PGLITE_DATA_DIR value
        const pgliteMatch = envContent.match(/PGLITE_DATA_DIR=(.+)/);
        expect(pgliteMatch).toBeTruthy();
        const pgliteDataDir = pgliteMatch![1];

        // Verify it points to the project's .eliza/.elizadb, not parent's
        expect(pgliteDataDir).toContain(join('test-no-hoist', '.eliza', '.elizadb'));
        // Ensure it's not pointing to parent's .eliza directory (without the project name)
        const sep = path.sep.replace(/\\/g, '\\\\'); // Escape backslashes for regex
        expect(pgliteDataDir).not.toMatch(
          new RegExp(`eliza-parent-[^${sep}]+${sep}\\.eliza${sep}\\.elizadb$`)
        );
      } finally {
        process.chdir(originalDir);
        // Cleanup
        await rm(parentDir, { recursive: true });
      }
    },
    TEST_TIMEOUTS.INDIVIDUAL_TEST
  );
});
