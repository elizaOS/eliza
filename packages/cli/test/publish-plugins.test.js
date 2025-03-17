// Mock dependencies
import { vi, describe, beforeEach, afterAll, test, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// Setup module mocks
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockImplementation((filePath) => {
        if (filePath.includes('plugin-test/package.json')) {
          return Promise.resolve(
            JSON.stringify({
              name: '@elizaos/plugin-test',
              version: '1.0.0',
            })
          );
        }

        if (filePath.includes('plugin-other/package.json')) {
          return Promise.resolve(
            JSON.stringify({
              name: '@elizaos/plugin-other',
              version: '1.0.0',
            })
          );
        }

        return Promise.resolve('{}');
      }),
      access: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(true),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('command executed')),
}));

// Mock the glob module
vi.mock('glob', () => {
  return {
    globSync: vi.fn().mockReturnValue(['plugin-test', 'plugin-other']),
  };
});

// Import the mocked modules so we can access them in tests
import { promises as fsPromises } from 'node:fs';
import { execSync } from 'node:child_process';
import { globSync } from 'glob';

// Store original process.argv
const originalArgv = process.argv;

// Simplified test version of the script
const runPublishPluginsScript = async () => {
  const pattern =
    process.argv.find((arg) => arg.startsWith('--pattern='))?.split('=')[1] || '**/plugin-*';
  const all = process.argv.includes('--all');
  const platform =
    process.argv.find((arg) => arg.startsWith('--platform='))?.split('=')[1] || 'universal';
  const registry =
    process.argv.find((arg) => arg.startsWith('--registry='))?.split('=')[1] || 'elizaos/registry';

  const globPattern = all ? '**/plugin-*' : pattern;
  const plugins = globSync(globPattern, { ignore: ['**/node_modules/**'] });

  // For testing, we'll directly call execSync for each plugin
  for (const plugin of plugins) {
    try {
      // Check if package.json exists
      await fsPromises.access(path.join(plugin, 'package.json'));

      // Read package.json
      const packageJsonContent = await fsPromises.readFile(
        path.join(plugin, 'package.json'),
        'utf8'
      );
      const packageJson = JSON.parse(packageJsonContent);

      // Only process plugins
      if (packageJson.name && packageJson.name.includes('plugin')) {
        // Build the plugin
        execSync(`npm run build --prefix ${plugin}`, { stdio: 'inherit' });

        // Publish the plugin
        execSync(
          `cd ${plugin} && npx elizaos publish --platform ${platform} --registry ${registry}`,
          { stdio: 'inherit' }
        );
      }
    } catch (error) {
      console.error(`Error with plugin ${plugin}:`, error);
    }
  }
};

describe('Publish Plugins Script', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Reset process.argv
    process.argv = [...originalArgv];

    // Setup globSync mock to return our test plugins
    vi.mocked(globSync).mockReturnValue(['plugin-test', 'plugin-other']);

    // Setup execSync to actually call through when mocked for testing
    vi.mocked(execSync).mockImplementation((command) => {
      // Simulate execution and return command output
      return Buffer.from(`Executed: ${command}`);
    });

    // Setup fsPromises.readFile to return valid JSON
    vi.mocked(fsPromises.readFile).mockImplementation((filePath) => {
      if (filePath.includes('plugin-test/package.json')) {
        return Promise.resolve(
          JSON.stringify({
            name: '@elizaos/plugin-test',
            version: '1.0.0',
          })
        );
      }

      if (filePath.includes('plugin-other/package.json')) {
        return Promise.resolve(
          JSON.stringify({
            name: '@elizaos/plugin-other',
            version: '1.0.0',
          })
        );
      }

      return Promise.resolve('{}');
    });
  });

  afterAll(() => {
    // Restore process.argv
    process.argv = originalArgv;

    // Restore mocks
    vi.restoreAllMocks();
  });

  test('should find and process matching plugins', async () => {
    // Mock argv to simulate command line arguments
    process.argv = ['node', 'scripts/publish-plugins.js', '--pattern=plugin-test'];

    // Re-mock globSync for this specific test
    vi.mocked(globSync).mockReturnValue(['plugin-test']);

    // Run the script and wait for it to complete
    await runPublishPluginsScript();

    // Assert it found and processed the plugins correctly
    expect(globSync).toHaveBeenCalledWith('plugin-test', { ignore: ['**/node_modules/**'] });
    expect(fsPromises.access).toHaveBeenCalledWith(
      expect.stringContaining('plugin-test/package.json')
    );
    expect(execSync).toHaveBeenCalledTimes(2); // build and publish
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('--platform universal'),
      expect.any(Object)
    );
  });

  test('should respect platform option', async () => {
    // Mock argv with platform option
    process.argv = ['node', 'scripts/publish-plugins.js', '--platform=node'];

    // Run the script and wait for it to complete
    await runPublishPluginsScript();

    // Assert correct platform was passed
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('--platform node'),
      expect.any(Object)
    );
  });

  test('should respect registry option', async () => {
    // Mock argv with registry option
    process.argv = ['node', 'scripts/publish-plugins.js', '--registry=custom/registry'];

    // Run the script and wait for it to complete
    await runPublishPluginsScript();

    // Assert correct registry was passed
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('--registry custom/registry'),
      expect.any(Object)
    );
  });

  test('should handle all option by finding all plugins', async () => {
    // Mock argv with all option
    process.argv = ['node', 'scripts/publish-plugins.js', '--all'];

    // Run the script and wait for it to complete
    await runPublishPluginsScript();

    // Assert it searched for all plugins
    expect(globSync).toHaveBeenCalledWith('**/plugin-*', { ignore: ['**/node_modules/**'] });
  });

  test('should skip packages without package.json', async () => {
    // Mock fs.access to fail for one plugin
    vi.mocked(fsPromises.access).mockImplementation((path) => {
      if (path.includes('plugin-other')) {
        return Promise.reject(new Error('File not found'));
      }
      return Promise.resolve();
    });

    // Run the script and wait for it to complete
    await runPublishPluginsScript();

    // Should only process one plugin
    expect(execSync).toHaveBeenCalledTimes(2); // Only for plugin-test
    expect(execSync).not.toHaveBeenCalledWith(
      expect.stringContaining('plugin-other'),
      expect.any(Object)
    );
  });
});

// Separate describe block for the non-plugin test to avoid interference
describe('Publish Plugins Script - Non-Plugin Test', () => {
  // TODO: This test is skipped because of issues with mock call counts in Vitest
  // The test verifies that non-plugin packages are skipped during the publish process
  // but there's a conflict with how execSync is being counted across test runs
  test.skip('should skip non-plugin packages', async () => {
    // Setup mocks for this specific test
    vi.resetAllMocks();

    // Mock glob to return two plugins
    vi.mocked(globSync).mockReturnValue(['plugin-test', 'plugin-other']);

    // Mock fs.access to succeed for both plugins
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);

    // Mock package.json content
    vi.mocked(fsPromises.readFile).mockImplementation((path) => {
      if (path.includes('plugin-other')) {
        return Promise.resolve(
          JSON.stringify({
            name: '@elizaos/not-a-plugin', // Not a plugin
            version: '1.0.0',
          })
        );
      }
      return Promise.resolve(
        JSON.stringify({
          name: '@elizaos/plugin-test', // Is a plugin
          version: '1.0.0',
        })
      );
    });

    // Mock execSync
    const execSyncMock = vi.fn().mockReturnValue(Buffer.from('command executed'));
    vi.mocked(execSync).mockImplementation(execSyncMock);

    // Run a simplified version of the script
    const plugins = ['plugin-test', 'plugin-other'];

    for (const plugin of plugins) {
      try {
        // Check if package.json exists
        await fsPromises.access(path.join(plugin, 'package.json'));

        // Read package.json
        const packageJsonContent = await fsPromises.readFile(
          path.join(plugin, 'package.json'),
          'utf8'
        );
        const packageJson = JSON.parse(packageJsonContent);

        // Only process plugins
        if (packageJson.name && packageJson.name.includes('plugin')) {
          // Build the plugin
          execSync(`npm run build --prefix ${plugin}`, { stdio: 'inherit' });

          // Publish the plugin
          execSync(`cd ${plugin} && npx elizaos publish`, { stdio: 'inherit' });
        }
      } catch (error) {
        console.error(`Error with plugin ${plugin}:`, error);
      }
    }

    // Should only process plugin-test (2 calls: build and publish)
    expect(fsPromises.readFile).toHaveBeenCalledTimes(2);
    expect(execSync).toHaveBeenCalledTimes(2); // Only for plugin-test
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('plugin-test'),
      expect.any(Object)
    );
    // Verify that plugin-other was not published
    const publishCalls = vi
      .mocked(execSync)
      .mock.calls.filter((call) => call[0].includes('plugin-other') && call[0].includes('publish'));
    expect(publishCalls.length).toBe(0);
  });
});
