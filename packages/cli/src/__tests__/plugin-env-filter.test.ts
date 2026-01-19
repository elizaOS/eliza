/**
 * Tests for plugin-based environment variable filtering
 *
 * These tests verify that:
 * 1. Plugin env var declarations are correctly scanned from package.json
 * 2. Env vars are properly filtered based on plugin declarations
 * 3. Shell environment leakage is prevented
 * 4. Core vars are always allowed
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  scanPluginsForEnvDeclarations,
  filterEnvVarsByPluginDeclarations,
  detectShellOnlyVars,
  warnAboutMissingDeclarations,
} from '../utils/plugin-env-filter';

describe('Plugin Environment Variable Filtering', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for test fixtures
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-env-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('scanPluginsForEnvDeclarations', () => {
    it('should return core vars when no plugins are installed', () => {
      const result = scanPluginsForEnvDeclarations(tempDir);

      expect(result.allowedVars).toBeInstanceOf(Set);
      expect(result.allowedVars.has('POSTGRES_URL')).toBe(true);
      expect(result.allowedVars.has('LOG_LEVEL')).toBe(true);
      expect(result.allowedVars.has('NODE_ENV')).toBe(true);
      expect(result.pluginsWithDeclarations).toHaveLength(0);
      expect(result.pluginsWithoutDeclarations).toHaveLength(0);
    });

    it('should exclude core vars when includeCoreVars is false', () => {
      const result = scanPluginsForEnvDeclarations(tempDir, { includeCoreVars: false });

      expect(result.allowedVars.has('POSTGRES_URL')).toBe(false);
      expect(result.allowedVars.has('LOG_LEVEL')).toBe(false);
    });

    it('should scan plugin with env var declarations', () => {
      // Create a mock plugin with env var declarations
      const nodeModulesPath = path.join(tempDir, 'node_modules', '@elizaos', 'plugin-test');
      fs.mkdirSync(nodeModulesPath, { recursive: true });

      const packageJson = {
        name: '@elizaos/plugin-test',
        version: '1.0.0',
        agentConfig: {
          pluginType: 'elizaos:plugin:1.0.0',
          pluginParameters: {
            TEST_API_KEY: {
              type: 'string',
              description: 'Test API key',
              required: true,
              sensitive: true,
            },
            TEST_ENDPOINT: {
              type: 'string',
              description: 'Test endpoint URL',
              required: false,
            },
          },
        },
      };

      fs.writeFileSync(
        path.join(nodeModulesPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const result = scanPluginsForEnvDeclarations(tempDir);

      expect(result.allowedVars.has('TEST_API_KEY')).toBe(true);
      expect(result.allowedVars.has('TEST_ENDPOINT')).toBe(true);
      expect(result.pluginsWithDeclarations).toContain('@elizaos/plugin-test');
      expect(result.varInfo.get('TEST_API_KEY')?.plugin).toBe('@elizaos/plugin-test');
    });

    it('should detect plugins without declarations', () => {
      // Create a mock plugin without env var declarations
      const nodeModulesPath = path.join(tempDir, 'node_modules', '@elizaos', 'plugin-empty');
      fs.mkdirSync(nodeModulesPath, { recursive: true });

      const packageJson = {
        name: '@elizaos/plugin-empty',
        version: '1.0.0',
        agentConfig: {
          pluginType: 'elizaos:plugin:1.0.0',
          // No pluginParameters
        },
      };

      fs.writeFileSync(
        path.join(nodeModulesPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const result = scanPluginsForEnvDeclarations(tempDir);

      expect(result.pluginsWithoutDeclarations).toContain('@elizaos/plugin-empty');
    });

    it('should scan multiple plugins', () => {
      // Create two mock plugins
      const plugin1Path = path.join(tempDir, 'node_modules', '@elizaos', 'plugin-one');
      const plugin2Path = path.join(tempDir, 'node_modules', '@elizaos', 'plugin-two');
      fs.mkdirSync(plugin1Path, { recursive: true });
      fs.mkdirSync(plugin2Path, { recursive: true });

      fs.writeFileSync(
        path.join(plugin1Path, 'package.json'),
        JSON.stringify({
          name: '@elizaos/plugin-one',
          version: '1.0.0',
          agentConfig: {
            pluginType: 'elizaos:plugin:1.0.0',
            pluginParameters: {
              PLUGIN_ONE_KEY: { type: 'string', description: 'Key for plugin one', required: true },
            },
          },
        })
      );

      fs.writeFileSync(
        path.join(plugin2Path, 'package.json'),
        JSON.stringify({
          name: '@elizaos/plugin-two',
          version: '1.0.0',
          agentConfig: {
            pluginType: 'elizaos:plugin:1.0.0',
            pluginParameters: {
              PLUGIN_TWO_KEY: { type: 'string', description: 'Key for plugin two', required: true },
            },
          },
        })
      );

      const result = scanPluginsForEnvDeclarations(tempDir);

      expect(result.allowedVars.has('PLUGIN_ONE_KEY')).toBe(true);
      expect(result.allowedVars.has('PLUGIN_TWO_KEY')).toBe(true);
      expect(result.pluginsWithDeclarations).toHaveLength(2);
    });

    it('should search parent directories for node_modules', () => {
      // Create a nested project structure
      const projectDir = path.join(tempDir, 'projects', 'my-project');
      const parentNodeModules = path.join(tempDir, 'node_modules', '@elizaos', 'plugin-parent');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(parentNodeModules, { recursive: true });

      fs.writeFileSync(
        path.join(parentNodeModules, 'package.json'),
        JSON.stringify({
          name: '@elizaos/plugin-parent',
          version: '1.0.0',
          agentConfig: {
            pluginType: 'elizaos:plugin:1.0.0',
            pluginParameters: {
              PARENT_KEY: { type: 'string', description: 'Parent key', required: true },
            },
          },
        })
      );

      const result = scanPluginsForEnvDeclarations(projectDir);

      expect(result.allowedVars.has('PARENT_KEY')).toBe(true);
    });
  });

  describe('filterEnvVarsByPluginDeclarations', () => {
    it('should filter out undeclared env vars', () => {
      const envVars = {
        ALLOWED_KEY: 'value1',
        SHELL_VAR: 'leaked',
        ANOTHER_ALLOWED: 'value2',
        PATH: '/usr/bin',
        HOME: '/home/user',
      };

      const allowedVars = new Set(['ALLOWED_KEY', 'ANOTHER_ALLOWED']);
      const filtered = filterEnvVarsByPluginDeclarations(envVars, allowedVars);

      expect(filtered).toEqual({
        ALLOWED_KEY: 'value1',
        ANOTHER_ALLOWED: 'value2',
      });
      expect(filtered.SHELL_VAR).toBeUndefined();
      expect(filtered.PATH).toBeUndefined();
      expect(filtered.HOME).toBeUndefined();
    });

    it('should handle undefined values', () => {
      const envVars: Record<string, string | undefined> = {
        DEFINED: 'value',
        UNDEFINED: undefined,
      };

      const allowedVars = new Set(['DEFINED', 'UNDEFINED']);
      const filtered = filterEnvVarsByPluginDeclarations(envVars, allowedVars);

      expect(filtered.DEFINED).toBe('value');
      expect('UNDEFINED' in filtered).toBe(false);
    });

    it('should return empty object when no vars are allowed', () => {
      const envVars = {
        KEY1: 'value1',
        KEY2: 'value2',
      };

      const allowedVars = new Set<string>();
      const filtered = filterEnvVarsByPluginDeclarations(envVars, allowedVars);

      expect(Object.keys(filtered)).toHaveLength(0);
    });
  });

  describe('detectShellOnlyVars', () => {
    it('should detect vars not in .env file', () => {
      // Create a .env file
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'PROJECT_KEY=value\nANOTHER_KEY=value');

      const processEnv = {
        PROJECT_KEY: 'value',
        ANOTHER_KEY: 'value',
        SHELL_VAR: 'leaked',
        ANTHROPIC_API_KEY: 'from-shell',
      };

      const shellOnly = detectShellOnlyVars(envPath, processEnv);

      expect(shellOnly.has('SHELL_VAR')).toBe(true);
      expect(shellOnly.has('ANTHROPIC_API_KEY')).toBe(true);
      expect(shellOnly.has('PROJECT_KEY')).toBe(false);
      expect(shellOnly.has('ANOTHER_KEY')).toBe(false);
    });

    it('should ignore npm_ and _ prefixed vars', () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'KEY=value');

      const processEnv = {
        KEY: 'value',
        _: '/usr/bin/node',
        npm_package_version: '1.0.0',
        SHELL_VAR: 'leaked',
      };

      const shellOnly = detectShellOnlyVars(envPath, processEnv);

      expect(shellOnly.has('SHELL_VAR')).toBe(true);
      expect(shellOnly.has('_')).toBe(false);
      expect(shellOnly.has('npm_package_version')).toBe(false);
    });

    it('should handle missing .env file', () => {
      const processEnv = {
        SOME_VAR: 'value',
      };

      const shellOnly = detectShellOnlyVars('/nonexistent/.env', processEnv);

      expect(shellOnly.has('SOME_VAR')).toBe(true);
    });

    it('should handle comments in .env file', () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, '# Comment\nKEY=value\n# COMMENTED_KEY=value');

      const processEnv = {
        KEY: 'value',
        COMMENTED_KEY: 'from-shell',
      };

      const shellOnly = detectShellOnlyVars(envPath, processEnv);

      expect(shellOnly.has('KEY')).toBe(false);
      expect(shellOnly.has('COMMENTED_KEY')).toBe(true);
    });
  });

  describe('warnAboutMissingDeclarations', () => {
    it('should return true when official plugins are missing declarations', () => {
      const plugins = ['@elizaos/plugin-missing', '@elizaos/plugin-also-missing'];
      const hasWarnings = warnAboutMissingDeclarations(plugins, { logLevel: 'debug' });

      expect(hasWarnings).toBe(true);
    });

    it('should return false when no official plugins are missing', () => {
      const plugins = ['some-third-party-plugin', 'another-custom-plugin'];
      const hasWarnings = warnAboutMissingDeclarations(plugins, { logLevel: 'debug' });

      expect(hasWarnings).toBe(false);
    });

    it('should return false for empty array', () => {
      const hasWarnings = warnAboutMissingDeclarations([], { logLevel: 'debug' });

      expect(hasWarnings).toBe(false);
    });
  });

  describe('Integration: Shell Leakage Prevention', () => {
    it('should demonstrate complete flow of filtering shell vars', () => {
      // Simulate a scenario where shell has extra vars
      const shellEnv = {
        // From .env file
        OPENROUTER_API_KEY: 'project-specific-key',
        POSTGRES_URL: 'postgresql://localhost/db',
        // From shell (leaked)
        ANTHROPIC_API_KEY: 'personal-shell-key',
        OPENAI_API_KEY: 'another-shell-key',
        // System vars (should be filtered)
        PATH: '/usr/bin',
        HOME: '/home/user',
        SHELL: '/bin/zsh',
      };

      // Create a mock plugin that declares only OPENROUTER_API_KEY
      const nodeModulesPath = path.join(tempDir, 'node_modules', '@elizaos', 'plugin-openrouter');
      fs.mkdirSync(nodeModulesPath, { recursive: true });

      fs.writeFileSync(
        path.join(nodeModulesPath, 'package.json'),
        JSON.stringify({
          name: '@elizaos/plugin-openrouter',
          version: '1.0.0',
          agentConfig: {
            pluginType: 'elizaos:plugin:1.0.0',
            pluginParameters: {
              OPENROUTER_API_KEY: {
                type: 'string',
                description: 'OpenRouter API key',
                required: true,
              },
            },
          },
        })
      );

      // Scan plugins
      const scanResult = scanPluginsForEnvDeclarations(tempDir);

      // Filter env vars
      const filtered = filterEnvVarsByPluginDeclarations(shellEnv, scanResult.allowedVars);

      // Verify: Only declared plugin vars + core vars are allowed
      expect(filtered.OPENROUTER_API_KEY).toBe('project-specific-key');
      expect(filtered.POSTGRES_URL).toBe('postgresql://localhost/db'); // Core var
      expect(filtered.ANTHROPIC_API_KEY).toBeUndefined(); // Shell leaked, not declared
      expect(filtered.OPENAI_API_KEY).toBeUndefined(); // Shell leaked, not declared
      expect(filtered.PATH).toBeUndefined(); // System var
      expect(filtered.HOME).toBeUndefined(); // System var
    });
  });
});
