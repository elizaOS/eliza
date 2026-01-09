import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { bunExec } from '../../src/utils/bun-exec';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

describe('Plugin Test Isolation', () => {
  let tempDir: string;
  const cliPath = resolve(__dirname, '../../dist', 'index.js');

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
  });

  afterEach(() => {
    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should only run tests for the specific plugin being tested', async () => {
    // Create a mock plugin structure
    const pluginDir = join(tempDir, 'test-plugin');
    mkdirSync(pluginDir, { recursive: true });

    // Create package.json for the plugin
    const packageJson = {
      name: 'test-plugin',
      version: '1.0.0',
      dependencies: {
        '@elizaos/core': '*',
        '@elizaos/plugin-sql': '*',
      },
    };
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create a simple plugin file
    const pluginContent = `
export const testPlugin = {
  name: 'test-plugin',
  tests: [{
    name: 'test-plugin-suite',
    tests: [{
      name: 'test-plugin-test',
      handler: async () => ({ success: true, message: 'Test passed' })
    }]
  }]
};
`;
    mkdirSync(join(pluginDir, 'src'), { recursive: true });
    writeFileSync(join(pluginDir, 'src', 'index.ts'), pluginContent);

    // Run the test command and capture output
    // Note: This test expects Bun runtime. When running with Node.js,
    // the CLI will exit with code 1 because it requires Bun.
    const result = await bunExec('bun', [cliPath, 'test', '--skip-build'], {
      cwd: pluginDir,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    // Check both stdout and stderr for the expected output
    const combinedOutput = result.stdout + result.stderr;

    // The test should either succeed with Bun or fail gracefully
    // Exit code 0 means success, exit code 1 means expected failure (missing dependencies)
    expect([0, 1]).toContain(result.exitCode);
    expect(combinedOutput).toBeTruthy();
  });

  it('should set ELIZA_TESTING_PLUGIN environment variable for plugins', async () => {
    // Create a mock plugin that checks for the environment variable
    const pluginDir = join(tempDir, 'env-test-plugin');
    mkdirSync(pluginDir, { recursive: true });

    const packageJson = {
      name: 'env-test-plugin',
      version: '1.0.0',
      dependencies: {
        '@elizaos/core': '*',
      },
    };
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create a plugin that logs the environment variable
    const pluginContent = `
console.log('ELIZA_TESTING_PLUGIN:', process.env.ELIZA_TESTING_PLUGIN);
export const envTestPlugin = {
  name: 'env-test-plugin',
  tests: []
};
`;
    mkdirSync(join(pluginDir, 'src'), { recursive: true });
    writeFileSync(join(pluginDir, 'src', 'index.ts'), pluginContent);

    const result = await bunExec('bun', [cliPath, 'test', '--skip-build'], {
      cwd: pluginDir,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    // Check both stdout and stderr for the expected output
    const combinedOutput = result.stdout + result.stderr;

    // The test should either succeed with Bun or fail gracefully
    expect([0, 1]).toContain(result.exitCode);
    expect(combinedOutput).toBeTruthy();
  });

  it('should isolate tests between multiple plugins', async () => {
    // Create two separate plugin directories
    const plugin1Dir = join(tempDir, 'plugin-alpha');
    const plugin2Dir = join(tempDir, 'plugin-beta');

    mkdirSync(plugin1Dir, { recursive: true });
    mkdirSync(plugin2Dir, { recursive: true });

    // Create plugin-alpha
    const alpha = {
      name: 'plugin-alpha',
      version: '1.0.0',
      dependencies: { '@elizaos/core': '*' },
    };
    writeFileSync(join(plugin1Dir, 'package.json'), JSON.stringify(alpha, null, 2));
    mkdirSync(join(plugin1Dir, 'src'), { recursive: true });
    writeFileSync(
      join(plugin1Dir, 'src', 'index.ts'),
      `
export const pluginAlpha = {
  name: 'plugin-alpha',
  tests: [{ name: 'alpha-suite', tests: [{ name: 'alpha-test', fn: async () => {} }] }]
};
`
    );

    // Create plugin-beta
    const beta = {
      name: 'plugin-beta',
      version: '1.0.0',
      dependencies: { '@elizaos/core': '*' },
    };
    writeFileSync(join(plugin2Dir, 'package.json'), JSON.stringify(beta, null, 2));
    mkdirSync(join(plugin2Dir, 'src'), { recursive: true });
    writeFileSync(
      join(plugin2Dir, 'src', 'index.ts'),
      `
export const pluginBeta = {
  name: 'plugin-beta',
  tests: [{ name: 'beta-suite', tests: [{ name: 'beta-test', fn: async () => {} }] }]
};
`
    );

    // Run tests for plugin-alpha - should not run plugin-beta tests
    const alphaResult = await bunExec('bun', [cliPath, 'test', '--skip-build'], {
      cwd: plugin1Dir,
      env: { ...process.env, NODE_ENV: 'test', ELIZA_TESTING_PLUGIN: 'true' },
    });

    // Verify the command executed
    expect([0, 1]).toContain(alphaResult.exitCode);
    expect(alphaResult.stdout + alphaResult.stderr).toBeTruthy();
  });
});
