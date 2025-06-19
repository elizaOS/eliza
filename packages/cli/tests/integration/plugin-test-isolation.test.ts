import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Plugin Test Isolation', () => {
  let tempDir: string;
  const cliPath = join(process.cwd(), 'dist', 'index.js');

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
  });

  afterEach(() => {
    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should only run tests for the specific plugin being tested', () => {
    // Create a mock plugin structure
    const pluginDir = join(tempDir, 'test-plugin');
    mkdirSync(pluginDir, { recursive: true });
    
    // Create package.json for the plugin
    const packageJson = {
      name: 'test-plugin',
      version: '1.0.0',
      dependencies: {
        '@elizaos/core': '*',
        '@elizaos/plugin-sql': '*'
      }
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
    try {
      const output = execSync(`node ${cliPath} test --skip-build`, {
        cwd: pluginDir,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' }
      });
      
      // Verify the output shows plugin test isolation
      expect(output).toContain('plugin: test-plugin');
      expect(output).not.toContain('Running test suite: sql_test_suite');
      expect(output).not.toContain('@elizaos/plugin-sql');
    } catch (error) {
      const errorOutput = error instanceof Error && 'stderr' in error ? (error as any).stderr : 
                         error instanceof Error && 'stdout' in error ? (error as any).stdout : '';
      expect(errorOutput).toContain('plugin-test-a');
    }
  });

  it('should set ELIZA_TESTING_PLUGIN environment variable for plugins', () => {
    // Create a mock plugin that checks for the environment variable
    const pluginDir = join(tempDir, 'env-test-plugin');
    mkdirSync(pluginDir, { recursive: true });
    
    const packageJson = {
      name: 'env-test-plugin',
      version: '1.0.0',
      dependencies: {
        '@elizaos/core': '*'
      }
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
    
    try {
      const output = execSync(`node ${cliPath} test --skip-build`, {
        cwd: pluginDir,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' }
      });
      
      // The environment variable should be set
      expect(output).toContain('ELIZA_TESTING_PLUGIN: true');
    } catch (error) {
      const errorOutput = error instanceof Error && 'stderr' in error ? (error as any).stderr : 
                         error instanceof Error && 'stdout' in error ? (error as any).stdout : '';
      expect(errorOutput).toContain('plugin-test-b');
    }
  });
}); 